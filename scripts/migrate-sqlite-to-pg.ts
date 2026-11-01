/**
 * SQLite → PostgreSQL 一次性数据迁移 —— migrate_sqlite_to_pg.py
 *
 * 只迁 app/models.py（现 src/db/schema.ts）里定义的业务表：
 *   users / sessions / pending_files / export_results /
 *   audit_logs / data_applies / messages / platform_config
 * （dataset_meta / dataset_rows 是已被宽表方案取代的死代码表，本就不在 ORM 里）
 *
 * 分析宽表 test_data 不在 ORM 内，迁移完成后用宽表脚本从 CSV 重建：
 *   npm run db:testdata -- --csv <路径> --table test_data --drop
 * 这样能顺带修掉 SQLite 下 SERIAL 不生效导致的 id 为空、导出 Excel 行序错乱问题。
 *
 * 用法（目标 PG 库已创建）：
 *   npm run db:migrate-sqlite -- --sqlite ./stats_platform.db --pg-url "postgres://stats:pwd@127.0.0.1:5432/stats_platform"
 *   npm run db:migrate-sqlite -- --force      # 导入前清空目标表数据（表结构保留）
 *   npm run db:migrate-sqlite -- --dry-run    # 只统计行数，不写库
 *
 * 与 Python 的差异：
 *  1. 读 SQLite 用 Node 内置的 `node:sqlite`（Node ≥ 22.5，实验特性），
 *     不引入 better-sqlite3 这类需要 native 编译的依赖。
 *  2. 目标库建表不再用 `Base.metadata.create_all()`，而是走 drizzle 版本化迁移
 *     （`runMigrations()`），与运行时启动路径完全一致。
 *  3. 列名不再硬编码：源列取自 SQLite 的 `PRAGMA table_info`，再与
 *     Drizzle 表定义里的列名求交集 —— 老库多出来的列（如 sessions.software）
 *     会被自动跳过并告警，不会因列漂移整表失败。
 *  4. SQLAlchemy 的 `executemany` 由驱动展开；pg 需要自己拼多值 INSERT，
 *     并按 PostgreSQL 的 65535 参数上限动态决定每批行数。
 *  5. --force 的清表顺序改为**外键依赖倒序**（Python 是按迁移正序 DELETE，
 *     父表有子行时会撞外键约束）。
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * 注意：src/** 一律走**动态 import**，不能提到文件顶部。
 * 原因：`src/config/env.ts` 的 settings 是模块级单例，import 的瞬间就做 zod 校验并
 * fail-fast。而本脚本的目标库地址来自命令行 `--pg-url`，`.env` 里的 DATABASE_URL
 * 通常仍是 sqlite://，若静态 import 会先于我们改写环境变量而崩溃。
 * （Python 版没有这个问题：`create_engine(pg_url)` 是运行时求值，不走配置单例。）
 */

/** PostgreSQL 单条语句参数上限 */
const MAX_PARAMS = 65_535;
const MAX_ROWS_PER_BATCH = 500;

type SqlValue = string | number | bigint | boolean | null | Uint8Array;

interface Options {
  readonly sqlitePath: string;
  readonly pgUrl: string;
  readonly force: boolean;
  readonly dryRun: boolean;
}

/** PostgreSQL 标识符：中文表名/列名必须双引号包裹，内部双引号转义 */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const parseArgs = (argv: readonly string[]): Options => {
  const parsed: { sqlitePath?: string; pgUrl?: string; force: boolean; dryRun: boolean } = {
    force: false, dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = argv[index + 1];

    if (arg === '--force') {
      parsed.force = true;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--sqlite' && value !== undefined) {
      parsed.sqlitePath = value;
      index += 1;
    } else if (arg === '--pg-url' && value !== undefined) {
      parsed.pgUrl = value;
      index += 1;
    } else {
      throw new Error(`未知参数: ${arg}（可用：--sqlite / --pg-url / --force / --dry-run）`);
    }
  }

  if (parsed.pgUrl === undefined) {
    throw new Error('缺少必填参数 --pg-url');
  }

  return {
    sqlitePath: parsed.sqlitePath ?? './stats_platform.db',
    pgUrl: parsed.pgUrl,
    force: parsed.force,
    dryRun: parsed.dryRun,
  };
};

/** SQLite 的值收窄成 pg 能序列化的类型 */
const asSqlValue = (value: unknown): SqlValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value;
  if (value instanceof Uint8Array) return value;
  return String(value);
};

/** SQLite 存布尔为 0/1；PG boolean 列需要显式转换（避免把 '0' 解释成 true） */
const convertColumn = (column: PgColumn, value: SqlValue): SqlValue => {
  if (value === null) return null;
  if (column.getSQLType() === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value !== '0' && value !== '';
    return Boolean(value);
  }
  return value;
};

const pgColumnMap = (table: PgTable): ReadonlyMap<string, PgColumn> => {
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  const map = new Map<string, PgColumn>();
  for (const column of Object.values(columns)) {
    map.set(column.name, column);
  }
  return map;
};

interface SqliteColumn {
  readonly name: string;
  readonly type: string;
}

const readSqliteColumns = (db: DatabaseSync, table: string): readonly SqliteColumn[] => {
  // PRAGMA 不接受绑定参数，表名只能拼进去；quoteIdent 已转义双引号
  const rows = db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all() as { name?: unknown; type?: unknown }[];

  return rows
    .map((row) => ({
      name: typeof row.name === 'string' ? row.name : '',
      type: typeof row.type === 'string' ? row.type : '',
    }))
    .filter((column) => column.name !== '');
};

const listSqliteTables = (db: DatabaseSync): readonly string[] => {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as { name?: unknown }[];

  return rows
    .filter((row): row is { name: string } => typeof row.name === 'string')
    .map((row) => row.name);
};

/** PG 序列对齐到当前最大 id，防止后续插入主键冲突 */
const resetSequence = async (
  client: { query: (sql: string) => Promise<unknown> },
  table: string,
): Promise<void> => {
  await client.query(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), `
      + `COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1), `
      + `(SELECT COUNT(*) FROM ${quoteIdent(table)}) > 0)`,
  );
};

const main = async (): Promise<void> => {
  const { sqlitePath, pgUrl, force, dryRun } = parseArgs(process.argv.slice(2));

  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite 文件不存在: ${sqlitePath}`);
  }

  // 必须在 import src/** 之前：settings 单例加载时会读这个值并校验
  process.env.DATABASE_URL = pgUrl;

  const { runMigrations } = await import('../src/bootstrap/migrate.js');
  const { closeDatabase, getPool } = await import('../src/db/client.js');
  const schema = await import('../src/db/schema.js');

  /** 迁移顺序：被引用的表在前，避免外键约束（PG 默认不延迟检查） */
  const migrateOrder: readonly PgTable[] = [
    schema.users, schema.remoteSessions, schema.pendingFiles, schema.exportResults,
    schema.auditLogs, schema.dataApplies, schema.messages, schema.platformConfig,
  ];

  // 目标库：复用与运行时完全相同的连接池路径
  const pool = getPool();

  const sqlite = new DatabaseSync(sqlitePath);
  try {
    /* ---- 1. 源库现有表 ---- */
    const srcTables = new Set(listSqliteTables(sqlite));
    console.log(`[1/4] 源库表: ${[...srcTables].sort().join(', ')}`);

    /* ---- 2. 目标库建表 ---- */
    if (dryRun) {
      console.log('[2/4] dry-run：跳过建表');
    } else {
      console.log('[2/4] 在目标 PG 应用 Drizzle 迁移（已应用则跳过）...');
      await runMigrations();
    }

    /* ---- 3. 逐表导数据 ---- */
    console.log('[3/4] 迁移数据...');

    // --force 先按外键倒序清表（Python 按正序 DELETE，父表有子行会撞外键）
    if (force && !dryRun) {
      for (const table of [...migrateOrder].reverse()) {
        const name = getTableName(table);
        if (!srcTables.has(name)) continue;
        await pool.query(`DELETE FROM ${quoteIdent(name)}`);
      }
      console.log('      已清空目标表（--force）');
    }

    const client = await pool.connect();
    let total = 0;

    try {
      for (const table of migrateOrder) {
        const name = getTableName(table);

        if (!srcTables.has(name)) {
          console.log(`      - ${name}: 源库无此表，跳过`);
          continue;
        }

        const pgColumns = pgColumnMap(table);
        const sqliteColumns = readSqliteColumns(sqlite, name);
        const usable = sqliteColumns.filter((column) => pgColumns.has(column.name));
        const dropped = sqliteColumns
          .filter((column) => !pgColumns.has(column.name))
          .map((column) => column.name);

        if (dropped.length > 0) {
          console.log(`      - ${name}: 源库列 ${dropped.join(', ')} 在新 schema 中不存在，跳过`);
        }
        if (usable.length === 0) {
          console.log(`      - ${name}: 无可迁移列，跳过`);
          continue;
        }

        const columnList = usable.map((column) => column.name);
        const rows = sqlite.prepare(
          `SELECT ${columnList.map(quoteIdent).join(', ')} FROM ${quoteIdent(name)}`,
        ).all() as Record<string, unknown>[];

        if (rows.length === 0) {
          console.log(`      - ${name}: 0 行`);
          continue;
        }

        if (dryRun) {
          console.log(`      - ${name}: ${rows.length} 行（dry-run 未写入）`);
          total += rows.length;
          continue;
        }

        const rowsPerBatch = Math.max(
          1,
          Math.min(MAX_ROWS_PER_BATCH, Math.floor(MAX_PARAMS / columnList.length)),
        );

        await client.query('BEGIN');
        try {
          for (let start = 0; start < rows.length; start += rowsPerBatch) {
            const batch = rows.slice(start, start + rowsPerBatch);
            const placeholders: string[] = [];
            const values: SqlValue[] = [];

            batch.forEach((row, rowIndex) => {
              const rowPlaceholders = columnList.map((columnName, columnIndex) => {
                const raw = asSqlValue(row[columnName]);
                values.push(convertColumn(pgColumns.get(columnName)!, raw));
                return `$${rowIndex * columnList.length + columnIndex + 1}`;
              });
              placeholders.push(`(${rowPlaceholders.join(', ')})`);
            });

            await client.query(
              `INSERT INTO ${quoteIdent(name)} (${columnList.map(quoteIdent).join(', ')}) `
                + `VALUES ${placeholders.join(', ')}`,
              values,
            );
          }

          // platform_config 主键是字符串 key，没有 id 序列
          if (table !== schema.platformConfig) {
            await resetSequence(client, name);
          }

          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }

        console.log(`      - ${name}: ${rows.length} 行 ✓`);
        total += rows.length;
      }
    } finally {
      client.release();
    }

    /* ---- 4. 汇总 ---- */
    console.log(`[4/4] 完成，共迁移 ${total} 行`);
    if (dryRun) {
      console.log('      （dry-run 模式，未写入任何数据）');
    } else {
      console.log('      下一步：重建分析宽表');
      console.log('      npm run db:testdata -- --csv <CSV路径> --table test_data --drop');
    }
  } finally {
    sqlite.close();
    // 与 Python 版不同：pg 连接池必须显式关闭，否则进程不会自己退出
    await closeDatabase();
  }
};

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
};

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
