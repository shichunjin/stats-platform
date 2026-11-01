/**
 * 分析 CSV 并在 PostgreSQL 建宽表、批量导入 —— create_testdata_table.py
 *
 * 用法：
 *   npm run db:testdata -- --csv ./testData.csv --table test_data
 *   npm run db:testdata -- --drop          # 导入前先删同名表
 *
 * 与 Python 的差异：
 *  - `csv.reader` → `csv-parse/sync`。Python 的 `newline=""` + csv 模块对引号/换行的
 *    处理，csv-parse 用 `relax_column_count` + 默认引号规则覆盖；
 *    中文列名不受影响（UTF-8 全程）。
 *  - 编码嗅探：Python 靠 `UnicodeDecodeError` 逐个试编码；iconv-lite 几乎不抛异常，
 *    改用「替换字符 U+FFFD 是否存在」判断（与 transfer.ts 的 decodeRemote 同一套路）。
 *  - 批量插入：SQLAlchemy 的 `executemany` 由驱动展开；pg 需要自己拼多值 INSERT，
 *    并按 PostgreSQL 的 65535 参数上限动态决定每批行数。
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import iconv from 'iconv-lite';
import { parse } from 'csv-parse/sync';
import { closeDatabase, getPool } from '../src/db/client.js';
import { getSettings } from '../src/config/env.js';

type ColumnType = 'int' | 'float' | 'text' | 'empty';

interface CsvData {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** Python 侧的顺序：utf-8-sig → gbk → gb18030 → latin-1 */
const ENCODINGS = ['utf8', 'gbk', 'gb18030', 'latin1'] as const;

/** PostgreSQL 单条语句参数上限 */
const MAX_PARAMS = 65_535;

const readCsv = (csvPath: string): CsvData => {
  const buffer = readFileSync(csvPath);

  for (const encoding of ENCODINGS) {
    const text = iconv.decode(buffer, encoding);
    // GB18030/Latin-1 几乎能解码任意字节流，只能靠替换字符比例判断
    if (text.includes('\uFFFD')) continue;

    const records = parse(text, {
      relax_column_count: true,
      skip_empty_lines: true,
      bom: true,
    }) as string[][];

    const [header, ...rows] = records;
    if (header !== undefined && header.length > 0) {
      return { header, rows };
    }
  }

  throw new Error(`无法解析 CSV 文件编码: ${csvPath}`);
};

const detectColumnTypes = (
  header: readonly string[],
  rows: readonly (readonly string[])[],
): readonly ColumnType[] => header.map((_, index) => {
  const values = rows
    .map((row) => (index < row.length ? row[index]!.trim() : ''))
    .filter((value) => value !== '');

  if (values.length === 0) return 'empty';

  // /^-?\d+$/ 但 Python 用的是 v.lstrip("-").isdigit()，等价
  if (values.every((value) => /^-?\d+$/.test(value))) return 'int';
  if (values.every((value) => Number.isFinite(Number(value)) && value !== '')) return 'float';
  // 日期（M/D/YYYY）仍存 text，避免格式转换风险
  return 'text';
});

/** PostgreSQL 标识符：中文列名必须双引号包裹，内部双引号转义 */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const pgType = (columnType: ColumnType): string => {
  if (columnType === 'int') return 'INTEGER';
  if (columnType === 'float') return 'DOUBLE PRECISION';
  return 'TEXT';
};

const buildCreateTable = (
  tableName: string,
  header: readonly string[],
  columnTypes: readonly ColumnType[],
): string => {
  const columns = header.map((name, index) => `  ${quoteIdent(name)} ${pgType(columnTypes[index]!)}`);
  return [
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (`,
    '  "id" SERIAL PRIMARY KEY,',
    columns.join(',\n'),
    ');',
  ].join('\n');
};

/** 空字符串 → null；转换失败则回落为原文本（与 Python 一致） */
const convertValue = (raw: string, columnType: ColumnType): string | number | null => {
  const value = raw.trim();
  if (value === '') return null;

  if (columnType === 'int') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : value;
  }
  if (columnType === 'float') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
};

interface Options {
  readonly csvPath: string;
  readonly tableName: string;
  readonly drop: boolean;
}

const parseArgs = (argv: readonly string[]): Options => {
  const options: { csvPath?: string; tableName?: string; drop: boolean } = { drop: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--drop') {
      options.drop = true;
      continue;
    }
    const value = argv[index + 1];
    if (arg === '--csv' && value !== undefined) {
      options.csvPath = value;
      index += 1;
    } else if (arg === '--table' && value !== undefined) {
      options.tableName = value;
      index += 1;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  const { datasetCsvPath, testdataTable } = getSettings();
  return {
    csvPath: options.csvPath ?? datasetCsvPath,
    tableName: options.tableName ?? testdataTable,
    drop: options.drop,
  };
};

const main = async (): Promise<void> => {
  const { csvPath, tableName, drop } = parseArgs(process.argv.slice(2));

  if (!existsSync(csvPath)) {
    throw new Error(`CSV 文件不存在: ${csvPath}`);
  }

  console.log(`[1/4] 读取 CSV: ${csvPath}`);
  const { header, rows } = readCsv(csvPath);
  console.log(`      列数: ${header.length}, 行数: ${rows.length}`);

  console.log('[2/4] 分析列数据类型...');
  const columnTypes = detectColumnTypes(header, rows);
  const distribution = columnTypes.reduce<Record<string, number>>((acc, type) => {
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`      类型分布: ${JSON.stringify(distribution)}`);

  const pool = getPool();
  const client = await pool.connect();

  try {
    console.log(`[3/4] 建表: ${tableName}`);
    await client.query('BEGIN');

    if (drop) {
      await client.query(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
      console.log(`      已删除旧表 ${tableName}`);
    }
    await client.query(buildCreateTable(tableName, header, columnTypes));
    console.log(`      表 ${tableName} 创建完成（含 ${header.length} 列 + id 主键）`);

    console.log(`[4/4] 导入数据（共 ${rows.length} 行）...`);
    const columnList = header.map(quoteIdent).join(', ');
    // 按参数上限反推每批行数：ncols 很大时自动缩小批次，绝不触碰 65535
    const rowsPerBatch = Math.max(1, Math.min(500, Math.floor(MAX_PARAMS / header.length)));

    let imported = 0;
    for (let start = 0; start < rows.length; start += rowsPerBatch) {
      const batch = rows.slice(start, start + rowsPerBatch);
      const placeholders: string[] = [];
      const values: (string | number | null)[] = [];

      batch.forEach((row, rowIndex) => {
        const rowPlaceholders: string[] = [];
        header.forEach((_name, columnIndex) => {
          values.push(convertValue(
            columnIndex < row.length ? row[columnIndex]! : '',
            columnTypes[columnIndex]!,
          ));
          rowPlaceholders.push(`$${rowIndex * header.length + columnIndex + 1}`);
        });
        placeholders.push(`(${rowPlaceholders.join(', ')})`);
      });

      await client.query(
        `INSERT INTO ${quoteIdent(tableName)} (${columnList}) VALUES ${placeholders.join(', ')}`,
        values,
      );

      imported += batch.length;
      console.log(`      已导入 ${imported}/${rows.length} 行`);
    }

    await client.query('COMMIT');

    console.log('');
    console.log('[成功] 数据导入完成！');
    console.log(`        表名: ${tableName}`);
    console.log(`        总行数: ${imported}`);
    console.log(`        总列数: ${header.length}`);
    console.log(`        整数列: ${distribution.int ?? 0}`);
    console.log(`        浮点列: ${distribution.float ?? 0}`);
    console.log(`        文本列: ${distribution.text ?? 0}`);
    console.log(`        空列: ${distribution.empty ?? 0}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
};

if (isDirectRun()) {
  main()
    .catch((error: unknown) => {
      console.error(`[错误] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => { void closeDatabase(); });
}
