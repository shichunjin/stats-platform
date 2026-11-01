/**
 * 结果审查服务 —— app/review.py
 *
 * 两道独立的关卡：
 *  1. `decideExportReview`：按扩展名门禁 + 与原始数据集的相似度，判定
 *     review / auto / reject（安全修复 A2）
 *  2. `reviewResult`：字段白名单 + 行数上限 + 敏感信息正则（安全修复 B8，
 *     免审自动发布前必须再过这一关）
 *
 * 与 Python 的行为差异：全部改为异步文件 IO。
 * Python 版跑在 FastAPI 的线程池里，同步 IO 无所谓；Node 里同步 IO 会阻塞
 * 事件循环，而这里会读 50MB 级文件并做 CPU 密集的相似度计算。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import iconv from 'iconv-lite';
import { getSettings } from '../config/env.js';

/* ---------------- 规则常量（与 Python 逐项对齐） ---------------- */

export const ALLOWED_EXTENSIONS = new Set(['.csv', '.png', '.jpg', '.out', '.txt', '.log', '.pdf']);

/** CSV 字段白名单（只允许聚合/统计结果列名） */
export const FIELD_WHITELIST = new Set([
  // 通用统计量
  'mean', 'median', 'std', 'sd', 'min', 'max', 'range',
  'n', 'count', 'freq', 'frequency', 'percent', 'percentage',
  'sum', 'total',
  // 回归系数
  'estimate', 'coef', 'coefficient', 'beta', 'b',
  'std_err', 'se', 'std_error', 'standard_error',
  't_value', 't', 'z_value', 'z',
  'p_value', 'p', 'pr', 'pr_gt', 'pr_lt',
  'ci_lower', 'ci_upper', 'ci_low', 'ci_high',
  'df', 'degrees_freedom',
  // 模型拟合
  'r_square', 'r_squared', 'rsquare', 'r2',
  'adj_r_square', 'adjusted_r_squared',
  'aic', 'bic', 'log_likelihood', 'll', 'deviance',
  'rmsea', 'cfi', 'tli', 'nnfi', 'srmr', 'chi_square', 'chi_sq', 'df_model',
  'n_obs', 'n_groups', 'observations',
  // 通用
  'variable', 'term', 'model', 'group', 'level', 'category',
  'method', 'type', 'label', 'name', 'statistic', 'value',
]);

/** 敏感字段名（列名命中即拒绝） */
export const SENSITIVE_FIELD_NAMES = new Set([
  'id', 'uid', 'user_id', 'patient_id', 'pid', 'ssn', 'social_security',
  'name', 'fullname', 'first_name', 'last_name', 'real_name',
  'phone', 'mobile', 'tel', 'telephone', 'phone_number',
  'id_card', 'id_number', 'identity', 'identity_card',
  'address', 'email', 'mail', 'ip', 'ip_address',
  'birth', 'birthday', 'dob', 'date_of_birth',
]);

const SENSITIVE_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\d{15,18}/, label: '疑似身份证号' },
  { pattern: /1[3-9]\d{9}/, label: '疑似手机号' },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}/, label: '疑似邮箱地址' },
  { pattern: /[\u4e00-\u9fa5]{2,4}(?:先生|女士|同志)/, label: '疑似姓名' },
];

export const MAX_CSV_ROWS = 200;
export const MAX_CSV_COLS = 30;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TEXT_READ_BYTES = 1024 * 1024;

/* ---------------- 规则审查（B8） ---------------- */

const fileSize = async (path: string): Promise<number | null> => {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
};

/** 审查单个结果文件；返回 [ok, reason] */
export const reviewResult = async (filePath: string): Promise<readonly [boolean, string]> => {
  const size = await fileSize(filePath);
  if (size === null) return [false, '文件不存在'] as const;

  const ext = extname(basename(filePath)).toLowerCase();

  // 1. 文件类型白名单
  if (!ALLOWED_EXTENSIONS.has(ext)) return [false, `不支持的文件类型: ${ext}`] as const;

  // 2. 文件大小上限 (50MB)
  if (size > MAX_FILE_BYTES) return [false, `文件过大: ${size} bytes（上限 50MB）`] as const;

  // 3. 图片直接通过（不可能包含行级数据）
  if (ext === '.png' || ext === '.jpg' || ext === '.pdf') {
    return [true, '图片/PDF 类型，审查通过'] as const;
  }

  // 4. CSV — 严格审查
  if (ext === '.csv') return reviewCsv(filePath);

  // 5. .out / .log / .txt — 敏感信息检查
  if (ext === '.out' || ext === '.log' || ext === '.txt') return reviewText(filePath);

  return [true, '审查通过'] as const;
};

const reviewCsv = async (filePath: string): Promise<readonly [boolean, string]> => {
  let rows: string[][];
  try {
    const raw = await readFile(filePath);
    // utf-8-sig 等价于先剥 BOM
    const text = iconv.decode(raw, 'utf8').replace(/^\uFEFF/, '');
    // Python csv.reader 允许各行列数不一致
    rows = parseCsv(text, { relax_column_count: true }) as string[][];
  } catch (error) {
    return [false, `CSV 解析异常: ${error instanceof Error ? error.message : String(error)}`] as const;
  }

  const header = rows[0];
  if (!header) return [false, 'CSV 文件为空'] as const;

  // 4a. 列数检查
  const ncols = header.length;
  if (ncols > MAX_CSV_COLS) {
    return [false, `列数过多: ${ncols}（上限 ${MAX_CSV_COLS}），疑似导出原始宽表`] as const;
  }

  // 4b. 字段名白名单检查
  const headerLower = header.map((h) => h.trim().toLowerCase().replace(/ /g, '_'));
  const nonWhitelisted: string[] = [];
  for (const h of headerLower) {
    if (SENSITIVE_FIELD_NAMES.has(h)) {
      return [false, `包含敏感字段名: '${h}'，禁止导出`] as const;
    }
    if (h && !FIELD_WHITELIST.has(h) && !h.startsWith('est_') && !h.startsWith('se_')) {
      nonWhitelisted.push(h);
    }
  }

  if (nonWhitelisted.length > 0) {
    // 允许少量未在白名单但也不敏感的字段，但超过 50% 则拒绝
    const ratio = ncols > 0 ? nonWhitelisted.length / ncols : 1;
    if (ratio > 0.5) {
      return [false, `字段白名单检查失败，${nonWhitelisted.length}/${ncols} 列不在白名单中: ${nonWhitelisted.slice(0, 10).join(', ')}`] as const;
    }
  }

  // 4c/4d. 行数 + 敏感数据内容检测
  let rowCount = 0;
  for (const row of rows.slice(1)) {
    rowCount += 1;
    if (rowCount > MAX_CSV_ROWS) {
      return [false, `行数超过上限 ${MAX_CSV_ROWS}，疑似导出原始明细数据`] as const;
    }
    for (const cell of row) {
      for (const { pattern, label } of SENSITIVE_PATTERNS) {
        if (pattern.test(String(cell))) {
          return [false, `数据中检测到${label}: ${String(cell).slice(0, 20)}...`] as const;
        }
      }
    }
  }

  return [true, `CSV 审查通过（${rowCount} 行, ${ncols} 列）`] as const;
};

const reviewText = async (filePath: string): Promise<readonly [boolean, string]> => {
  let content: string;
  try {
    const handle = await readFile(filePath);
    content = iconv.decode(handle.subarray(0, TEXT_READ_BYTES), 'utf8');
  } catch (error) {
    return [false, `文件解析异常: ${error instanceof Error ? error.message : String(error)}`] as const;
  }

  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(content)) return [false, `文件中检测到${label}`] as const;
  }

  const lines = content.split(/\r?\n/);
  const numericLines = lines.filter((line) => line.trim() && /^[\d.\s]+$/.test(line.trim())).length;
  if (lines.length > 500 && numericLines > lines.length * 0.8) {
    return [false, `疑似原始行级数据（${numericLines} 行纯数字行），禁止导出`] as const;
  }

  return [true, `文本文件审查通过（${lines.length} 行）`] as const;
};

/* ---------------- 目录扫描 / 哈希 ---------------- */

export const scanPendingDirectory = async (pendingDir: string): Promise<readonly string[]> => {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(pendingDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => `${pendingDir}/${entry.name}`);
  } catch {
    return [];
  }
};

/** B9：分块计算 SHA256，支持大文件 */
export const fileSha256 = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

/* ---------------- 相似度比对（A2） ---------------- */

const TEXT_EXTS = new Set(['.csv', '.txt', '.out', '.log', '.tsv', '.dat', '.tab', '.json', '.xml']);
const MAX_BASELINE_LINES = 20_000;
const MAX_CANDIDATE_CHARS = 2 * 1024 * 1024;
const MAX_XLSX_ROWS = 20_000;

const WS_PATTERN = /\s+/g;
const TOKEN_PATTERN = /[0-9A-Za-z_.]+/g;
const B64_BLOCK_PATTERN = /[A-Za-z0-9+/=]{200,}/g;

interface Baseline {
  readonly lineSet: ReadonlySet<string>;
  readonly tokens: ReadonlyMap<string, number>;
  readonly header: string;
}

/** 基线缓存：{abspath: {mtimeNs, size, ...baseline}} */
const baselineCache = new Map<string, { mtimeNs: bigint; size: bigint } & Baseline>();

/** 测试钩子：对应 conftest 的 `review._baseline_cache.clear()` */
export const resetBaselineCache = (): void => {
  baselineCache.clear();
};

/** 采样检测二进制：控制字符（排除常见文本空白符）占比 > 2% 视为二进制 */
const looksBinary = (raw: Buffer): boolean => {
  const sample = raw.subarray(0, 65_536);
  if (sample.length === 0) return false;
  let ctrl = 0;
  for (const byte of sample) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) ctrl += 1;
  }
  return ctrl / sample.length > 0.02;
};

/** 兼容 UTF-8/GBK 的整体解码（testData.csv 生产为 GBK） */
const decodeBytes = (raw: Buffer): string => {
  for (const encoding of ['utf8', 'gbk', 'latin1'] as const) {
    const text = iconv.decode(raw, encoding);
    if (!text.includes('\uFFFD')) return text;
  }
  return iconv.decode(raw, 'latin1');
};

const normalizeLine = (line: string): string => line.trim().replace(WS_PATTERN, ' ');

/** 编码混淆防护：Base64 块能解码成文本则并入比对，否则视为混淆 */
const augmentBase64Text = (text: string): readonly [string, boolean] => {
  const blocks = text.match(B64_BLOCK_PATTERN);
  if (!blocks) return [text, false] as const;

  const decodedParts: string[] = [];
  for (const block of blocks) {
    const padded = block + '='.repeat((-block.length % 4 + 4) % 4);
    let raw: Buffer;
    try {
      raw = Buffer.from(padded, 'base64');
      // Buffer 的 base64 解码很宽松，需回环校验以对齐 Python validate=True
      if (raw.toString('base64').replace(/=+$/, '') !== block.replace(/=+$/, '')) {
        throw new Error('invalid base64');
      }
    } catch {
      try {
        raw = Buffer.from(padded.replace(/\+/g, '-').replace(/\//g, '_'), 'base64');
      } catch {
        return [text, true] as const;
      }
    }
    if (looksBinary(raw)) return [text, true] as const;
    decodedParts.push(decodeBytes(raw));
  }

  if (decodedParts.length > 0) return [`${text}\n${decodedParts.join('\n')}`, false] as const;
  return [text, false] as const;
};

const loadBaseline = async (baselinePath: string): Promise<Baseline | null> => {
  // Python 用 st_mtime_ns 做缓存失效判定；Node 的普通 stat 只有浮点毫秒 mtimeMs，
  // 精度不足（同一毫秒内改文件会命中脏缓存），因此显式要 bigint 版本拿纳秒
  let stats: BigIntStats;
  try {
    stats = await stat(baselinePath, { bigint: true });
  } catch {
    return null;
  }

  const cached = baselineCache.get(baselinePath);
  if (cached && cached.mtimeNs === stats.mtimeNs && cached.size === stats.size) {
    return { lineSet: cached.lineSet, tokens: cached.tokens, header: cached.header };
  }

  const raw = await readFile(baselinePath);
  const lines = decodeBytes(raw).split(/\r?\n/);
  const lineSet = new Set<string>();
  const tokens = new Map<string, number>();
  let header = '';
  let n = 0;

  for (const line of lines) {
    const normalized = normalizeLine(line);
    if (!normalized) continue;
    if (n === 0) header = normalized;
    lineSet.add(normalized);
    for (const token of normalized.toLowerCase().match(TOKEN_PATTERN) ?? []) {
      tokens.set(token, (tokens.get(token) ?? 0) + 1);
    }
    n += 1;
    if (n >= MAX_BASELINE_LINES) break;
  }

  const baseline: Baseline = { lineSet, tokens, header };
  baselineCache.set(baselinePath, { mtimeNs: stats.mtimeNs, size: stats.size, ...baseline });
  return baseline;
};

const extractXlsxText = async (path: string): Promise<string> => {
  try {
    const ExcelJS = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);

    const parts: string[] = [];
    let rowCount = 0;
    workbook.eachSheet((worksheet) => {
      worksheet.eachRow({ includeEmpty: false }, (row) => {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        parts.push(values.map((cell) => (cell === null || cell === undefined ? '' : String(cell))).join(','));
        rowCount += 1;
      });
    });
    return rowCount >= MAX_XLSX_ROWS ? parts.slice(0, MAX_XLSX_ROWS).join('\n') : parts.join('\n');
  } catch {
    return '';
  }
};

/** 提取可用于比对的文本；null 表示无法提取（图片/PDF/二进制），不参与比对 */
export const extractComparableText = async (filePath: string): Promise<string | null> => {
  const ext = extname(filePath).toLowerCase();

  if (TEXT_EXTS.has(ext)) {
    let raw: Buffer;
    try {
      const handle = await readFile(filePath);
      raw = handle.subarray(0, MAX_CANDIDATE_CHARS);
    } catch {
      return '';
    }
    // A2：二进制伪装成文本扩展名（如 .dta 改名 .txt）无法可靠比对 → null 转人工
    if (looksBinary(raw)) return null;
    return decodeBytes(raw);
  }

  if (ext === '.xlsx') return extractXlsxText(filePath);
  return null;
};

/** 与原始数据集的相似度（0~1）；null 表示无法判定（安全默认转人工） */
export const similarityToDataset = async (
  filePath: string,
  baselinePath?: string,
): Promise<readonly [number | null, string]> => {
  const text = await extractComparableText(filePath);
  if (text === null) return [null, '无法提取可比文本（二进制/图片类），转人工审核'] as const;

  const [augmented, obfuscated] = augmentBase64Text(text);
  if (obfuscated) return [null, '内容疑似经编码/混淆处理且无法还原为可读文本，转人工审核'] as const;

  const base = await loadBaseline(baselinePath ?? getSettings().datasetCsvPath);
  if (base === null) return [null, '原始数据基线文件不可用，转人工审核'] as const;

  const candLines = augmented.split(/\r?\n/).map(normalizeLine).filter((line) => line.length > 0);
  if (candLines.length === 0) return [0, '文件内容为空'] as const;

  const { lineSet, tokens: baseTokens, header } = base;
  // 表头行不计入命中，避免小文件被一个表头推高相似度
  const dataLines = candLines.filter((line) => line !== header);

  const lineRatio = dataLines.length > 0
    ? dataLines.filter((line) => lineSet.has(line)).length / dataLines.length
    : 0;

  const candCounter = new Map<string, number>();
  for (const line of dataLines) {
    for (const token of line.toLowerCase().match(TOKEN_PATTERN) ?? []) {
      candCounter.set(token, (candCounter.get(token) ?? 0) + 1);
    }
  }

  let total = 0;
  let overlap = 0;
  for (const [token, count] of candCounter) {
    total += count;
    overlap += Math.min(count, baseTokens.get(token) ?? 0);
  }
  const tokenRatio = total > 0 ? overlap / total : 0;

  const score = Math.round(Math.max(lineRatio, tokenRatio) * 10_000) / 10_000;
  return [score, `行命中率 ${Math.round(lineRatio * 100)}%，token 覆盖率 ${Math.round(tokenRatio * 100)}%，相似度 ${Math.round(score * 100)}%`] as const;
};

/* ---------------- 导出类型门禁 ---------------- */

const AUTO_TEXT_EXTS = new Set(['.csv', '.txt', '.out', '.log', '.tsv', '.dat', '.tab', '.json', '.xml']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg']);
const ALWAYS_REVIEW_EXTS = new Set([
  '.xlsx', '.xls', '.xlsm', '.dta', '.rds', '.rdata', '.rda', '.sav', '.por',
  '.zip', '.7z', '.rar', '.gz', '.tgz', '.tar', '.pdf',
  '.doc', '.docx', '.ppt', '.pptx', '.h5', '.hdf5', '.mat', '.npz',
  '.parquet', '.feather', '.sqlite', '.db',
]);

export type ExportDecision = 'review' | 'auto' | 'reject';

/** 返回 [decision, reason, score] */
export const decideExportReview = async (
  filePath: string,
  threshold?: number,
): Promise<readonly [ExportDecision, string, number | null]> => {
  const thr = threshold ?? getSettings().exportReviewSimilarityThreshold;
  const ext = extname(filePath).toLowerCase();

  // 1. 类型门禁：未知/未允许类型直接拒绝
  if (!AUTO_TEXT_EXTS.has(ext) && !IMAGE_EXTS.has(ext) && !ALWAYS_REVIEW_EXTS.has(ext)) {
    return ['reject', `不允许导出的文件类型: ${ext}`, null] as const;
  }

  // 2. 统计软件原生格式/压缩包/文档：一律转人工
  if (ALWAYS_REVIEW_EXTS.has(ext)) {
    return ['review', '该文件类型（统计软件原生格式/压缩包/文档）可能内嵌原始数据，转管理员人工审核', null] as const;
  }

  // 3. 图片：免审自动通过
  if (IMAGE_EXTS.has(ext)) {
    return ['auto', '图片文件，不包含行级明细数据，免审自动通过', null] as const;
  }

  // 4. 文本类：相似度比对 + 编码混淆防护
  const [score, detail] = await similarityToDataset(filePath);
  if (score === null) return ['review', detail, null] as const;
  if (score >= thr) {
    return ['review', `${detail}，达到/超过阈值 ${Math.round(thr * 100)}%，需管理员审核`, score] as const;
  }
  return ['auto', `${detail}，低于阈值 ${Math.round(thr * 100)}%，免审核自动通过`, score] as const;
};
