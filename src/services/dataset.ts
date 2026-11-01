/**
 * 数据集：宽表列结构分析 + 按筛选生成 Excel —— app/dataset.py
 *
 * 与 Python 的关键差异：
 *  - SQL 用 drizzle 的 `sql` 模板 + `sql.identifier()` 做标识符转义，
 *    列名在拼进 SQL 前必须过白名单（物理列集合），防注入
 *  - Excel 生成改用 exceljs 的流式写入器（openpyxl 的 write_only 等价物）
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { DbSession } from '../db/session.js';

const MAX_ENUM_VALUES = 10;
const MAX_SAMPLE_ROWS = 5_000;

export interface ColumnMeta {
  readonly name: string;
  readonly type: 'int' | 'float' | 'date' | 'text';
  readonly control: 'select' | 'range' | 'input' | 'daterange';
  readonly options?: readonly (string | number)[];
  readonly min?: string | number;
  readonly max?: string | number;
}

/** 缓存：{tableName: {rowCount, meta}} —— 行数变化即失效 */
const columnsCache = new Map<string, { rowCount: number; meta: ColumnMeta[] }>();

/** 返回数据表的物理列名（按数据库顺序，排除 id） */
export const tableColumns = async (db: DbSession, tableName: string): Promise<readonly string[]> => {
  const result = await db.db.execute<{ column_name: string }>(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = ${tableName} ORDER BY ordinal_position
  `);
  return result.rows.map((row) => row.column_name).filter((name) => name !== 'id');
};

const allFloat = (values: readonly unknown[]): boolean => {
  if (values.length === 0) return false;
  return values.every((value) => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
    return false;
  });
};

const DATE_PATTERNS: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{4}\/\d{2}\/\d{2}$/,
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/,
];

const parseDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime()) && DATE_PATTERNS.some((p) => p.test(text))) return direct;
  return null;
};

const allDate = (values: readonly unknown[]): boolean =>
  values.length > 0 && values.every((value) => parseDate(value) !== null);

const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);

/** 分析宽表列结构，为前端智能筛选提供元数据 */
export const analyzeTableColumns = async (
  db: DbSession,
  tableName: string,
  useCache = true,
): Promise<ColumnMeta[]> => {
  const countResult = await db.db.execute<{ count: string }>(
    sql`SELECT COUNT(*) AS count FROM ${sql.identifier(tableName)}`,
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  if (useCache) {
    const cached = columnsCache.get(tableName);
    if (cached && cached.rowCount === total) return cached.meta;
  }

  const columns = await tableColumns(db, tableName);
  if (columns.length === 0) throw new Error(`数据表 ${tableName} 不存在或没有数据列`);

  const sample = await db.db.execute<Record<string, unknown>>(sql`
    SELECT ${sql.join(columns.map((col) => sql.identifier(col)), sql`, `)}
    FROM ${sql.identifier(tableName)} LIMIT ${MAX_SAMPLE_ROWS}
  `);

  const meta: ColumnMeta[] = columns.map((col) => {
    const values = sample.rows
      .map((row) => row[col])
      .filter((value) => value !== null && value !== undefined && value !== '');

    if (allFloat(values)) {
      const nums = values.map((value) => Number(value));
      const isInt = nums.every((num) => Number.isInteger(num));
      const distinct = [...new Set(nums)].sort((a, b) => a - b);

      if (distinct.length > 0 && distinct.length <= MAX_ENUM_VALUES) {
        return {
          name: col,
          type: isInt ? 'int' : 'float',
          control: 'select',
          options: distinct.map((num) => (Number.isInteger(num) ? num : num)),
        };
      }
      return {
        name: col,
        type: isInt ? 'int' : 'float',
        control: 'range',
        min: Math.min(...nums),
        max: Math.max(...nums),
      };
    }

    if (allDate(values)) {
      const dates = values.map((value) => parseDate(value)).filter((d): d is Date => d !== null);
      const iso = dates.map(toIsoDate);
      return {
        name: col,
        type: 'date',
        control: 'daterange',
        min: iso.length > 0 ? iso.sort()[0] : undefined,
        max: iso.length > 0 ? iso.sort()[iso.length - 1] : undefined,
      };
    }

    const distinct = [...new Set(values.map((value) => String(value)))];
    if (distinct.length > 0 && distinct.length <= MAX_ENUM_VALUES) {
      return { name: col, type: 'text', control: 'select', options: distinct };
    }
    return { name: col, type: 'text', control: 'input' };
  });

  columnsCache.set(tableName, { rowCount: total, meta });
  return meta;
};

/**
 * 把前端筛选条件转为参数化 WHERE 片段。
 * 列名先做白名单校验，防 SQL 注入。
 */
export const buildWhereClause = (
  filters: Readonly<Record<string, unknown>>,
  validColumns: ReadonlySet<string>,
  controls: Readonly<Record<string, string>> = {},
): SQL => {
  const clauses: SQL[] = [];

  for (const [col, rawValue] of Object.entries(filters)) {
    if (!validColumns.has(col) || rawValue === null || rawValue === undefined || rawValue === '') continue;

    const ident = sql.identifier(col);

    // 区间：[min, max]（可含 null）；日期列（daterange）按字符串区间处理
    const isRange = Array.isArray(rawValue) && rawValue.length === 2
      && (controls[col] === 'daterange'
        || rawValue.every((v) => v === null || typeof v === 'number'));

    if (isRange) {
      const [low, high] = rawValue as [unknown, unknown];
      if (low !== null && low !== undefined) clauses.push(sql`${ident} >= ${low as never}`);
      if (high !== null && high !== undefined) clauses.push(sql`${ident} <= ${high as never}`);
      continue;
    }

    // 枚举多选
    if (Array.isArray(rawValue)) {
      if (rawValue.length === 0) continue;
      clauses.push(sql`${ident} IN (${sql.join(rawValue.map((v) => sql`${v as never}`), sql`, `)})`);
      continue;
    }

    if (typeof rawValue === 'number') {
      clauses.push(sql`${ident} = ${rawValue}`);
    } else {
      clauses.push(sql`LOWER(CAST(${ident} AS TEXT)) LIKE LOWER(${`%${  String(rawValue)  }%`})`);
    }
  }

  return clauses.length > 0 ? sql` WHERE ${sql.join(clauses, sql` AND `)}` : sql``;
};

/** 按筛选条件从宽表查询数据生成 .xlsx，返回 [数据行数, 列数] */
export const generateFilteredExcelFromTable = async (
  db: DbSession,
  tableName: string,
  outputPath: string,
  filters: Readonly<Record<string, unknown>> = {},
): Promise<readonly [number, number]> => {
  const columns = await tableColumns(db, tableName);
  if (columns.length === 0) throw new Error(`数据表 ${tableName} 不存在或没有数据列`);

  let controls: Record<string, string> = {};
  try {
    const meta = await analyzeTableColumns(db, tableName);
    controls = Object.fromEntries(meta.map((col) => [col.name, col.control]));
  } catch {
    controls = {};
  }

  const where = buildWhereClause(filters, new Set(columns), controls);
  const result = await db.db.execute<Record<string, unknown>>(sql`
    SELECT ${sql.join(columns.map((col) => sql.identifier(col)), sql`, `)}
    FROM ${sql.identifier(tableName)}${where}
    ORDER BY ${sql.identifier('id')}
  `);

  await mkdir(dirname(outputPath), { recursive: true });

  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outputPath,
    useSharedStrings: false,
  });
  const worksheet = workbook.addWorksheet('data');
  worksheet.addRow([...columns]).commit();

  let rowCount = 0;
  for (const row of result.rows) {
    worksheet.addRow(columns.map((col) => row[col] ?? null)).commit();
    rowCount += 1;
  }

  worksheet.commit();
  await workbook.commit();

  return [rowCount, columns.length];
};

/** {base}_{YYYYMMDD_HHmmss}.{ext}，避免覆盖历史文件 */
export const timestampFilename = (base = 'testData', ext = 'xlsx'): string => {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${base}_${stamp}.${ext}`;
};
