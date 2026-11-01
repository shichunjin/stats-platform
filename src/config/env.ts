/**
 * 平台配置 —— app/config.py
 *
 * 行为契约（与原 Python 严格对齐）：
 *  1. fail-fast     : database_url / jwt_secret 缺失立即抛错，绝不回落到不安全的硬编码默认值
 *  2. 优先级        : 真实环境变量 > .env > 声明默认值（与 pydantic-settings 一致）
 *  3. 单例可变      : 测试可原地覆盖字段（对应 conftest.py 直接赋值 / pytest monkeypatch）
 *  4. .env 严格性   : 复刻 pydantic-settings 的 extra=forbid（见 assertKnownDotenvKeys）
 */
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { z, type ZodIssue } from 'zod';

type EnvSource = Record<string, string | undefined>;

/**
 * UPPER_SNAKE 环境变量名 → camelCase schema 字段名。
 *
 * pydantic-settings 大小写不敏感（DATABASE_URL 能匹配字段 database_url）；
 * process.env 在 Linux 上大小写敏感，且本项目 schema 字段是 camelCase，
 * 因此必须显式做一次 UPPER_SNAKE → camelCase 转换，否则所有环境变量都读不到。
 */
const toCamelCase = (key: string): string =>
  key.toLowerCase().replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());

const normalizeEnv = (source: EnvSource): Record<string, string> => {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    normalized[toCamelCase(key)] = value;
  }
  return normalized;
};

/** camelCase 字段名 → UPPER_SNAKE 环境变量名，仅用于生成可读的错误提示 */
const toUpperSnake = (field: string): string =>
  field.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase();

/* ---------------- 类型强制：env 全是 string，必须显式 coerce ---------------- */

const TRUE_TOKENS = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_TOKENS = new Set(['0', 'false', 'no', 'n', 'off']);

const coerceBoolean = (raw: unknown): unknown => {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return raw;
  const token = raw.trim().toLowerCase();
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  // 哨兵：非法取值不做静默回落，穿透到 zod 报错
  return Number.NaN;
};

const coerceNumber = (raw: unknown): unknown => {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? raw : parsed;
};

const boolFromEnv = (fallback: boolean) =>
  z.preprocess(coerceBoolean, z.boolean().default(fallback));

const numberFromEnv = (fallback: number) =>
  z.preprocess(coerceNumber, z.number().finite().default(fallback));

const intFromEnv = (fallback: number) =>
  z.preprocess(coerceNumber, z.number().int().nonnegative().default(fallback));

/* ---------------- DATABASE_URL 方言规整 ---------------- */

/**
 * SQLAlchemy 的驱动后缀：`postgresql+psycopg2://`、`postgres+asyncpg://` …
 * `pg` 驱动不认这种写法，但该后缀只用于指定 DBAPI、语义唯一，剥离后连接语义不变。
 *
 * 同一个 `.env` 要同时服务 Python 与 TS 两套实现，直接报 fatal 会让部署卡死，
 * 因此这里做**自动剥离 + 留痕告警**：既不停服，也不静默改写。
 */
const SQLALCHEMY_DRIVER_SUFFIX = /^(postgres(ql)?)\+[^:/@]+(?=:\/\/)/i;

const stripSqlAlchemyDriver = (value: string): string =>
  value.replace(SQLALCHEMY_DRIVER_SUFFIX, '$1');

/** 打码：告警里绝不能出现数据库密码 */
const maskUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<无法解析的连接串>';
  }
};

/**
 * 可恢复的配置问题（已自动改写），由 `takeConfigWarnings()` 取走后清空。
 * 与 ConfigError 的区别：这类问题不阻断启动，但必须留痕 —— 静默改写配置比报错更难排查。
 */
let pendingWarnings: string[] = [];

export const takeConfigWarnings = (): readonly string[] => {
  const taken = pendingWarnings;
  pendingWarnings = [];
  return taken;
};

/* ---------------- Schema：唯一真源，类型由此派生 ---------------- */

export const settingsSchema = z.object({
  /** prod（默认）| dev。dev 开放 /docs 并追加 localhost CORS 白名单 */
  appEnv: z.enum(['prod', 'dev']).default('prod'),

  /**
   * 只接受 `postgres://` / `postgresql://`（`pglite://` 仅供测试替身）。
   *
   * SQLAlchemy 的 `postgresql+psycopg2://` 会被自动剥离驱动后缀并记一条告警；
   * 其余不合法形态按类型给出可操作提示，避免「我明明配了 PostgreSQL 却还是报错」：
   *  - sqlite:// → TS 侧整体不支持，指向 db:migrate-sqlite
   *  - 其他      → 方言不对，给出正确格式
   */
  databaseUrl: z.string().min(1)
    .transform((value) => {
      const stripped = stripSqlAlchemyDriver(value);
      if (stripped !== value) {
        pendingWarnings.push(
          `DATABASE_URL 含 SQLAlchemy 驱动后缀，已自动按 ${maskUrl(stripped)} 处理；`
          + '建议把 .env 改成不带 +driver 的写法（SQLAlchemy 与 pg 两种实现都认）',
        );
      }
      return stripped;
    })
    .superRefine((value, ctx) => {
    const add = (message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    };

    if (/^sqlite/i.test(value)) {
      add('TS 侧不再支持 SQLite。请改用 PostgreSQL；旧库数据可用 '
        + 'npm run db:migrate-sqlite 迁入');
      return;
    }
    if (!/^(postgres(ql)?|pglite):\/\//i.test(value)) {
      add('TS 侧仅支持 PostgreSQL，形如 postgres://user:pwd@host:5432/dbname');
    }
  }),

  jwtSecret: z.string().min(1),
  jwtAlgorithm: z.string().default('HS256'),
  jwtExpireHours: intFromEnv(8),

  /** B1：测试环境置 false 关闭 */
  rateLimitEnabled: boolFromEnv(true),
  /** 是否信任 X-Forwarded-For。仅当 nginx 已覆盖该头时才可开启（SEC-04） */
  trustProxy: boolFromEnv(true),

  /** 演示账号密码；留空则禁用对应演示账号登录 */
  demoAdminPassword: z.string().default(''),
  demoUserPassword: z.string().default(''),

  fileserverRoot: z.string().default('./fileserver_data'),
  datasetCsvPath: z.string().default('testData.csv'),
  datasetName: z.string().default('testData'),
  testdataTable: z.string().default('test_data'),

  /** 相似度 ≥ 该值必须人工审核 */
  exportReviewSimilarityThreshold: numberFromEnv(0.6),
  exportPublishValidDays: intFromEnv(30),

  /** C1：后台生成任务软超时（秒） */
  generateTimeoutSeconds: intFromEnv(600),

  /** C5：仓库不内置真实主机 IP */
  sftpHost: z.string().default(''),
  sftpPort: intFromEnv(22),
  sftpUsername: z.string().default('Administrator'),
  sftpKeyPath: z.string().default('~/.ssh/stats_windows'),
  sftpPassphrase: z.string().default(''),
  windowsDataDir: z.string().default('C:/StatsData'),
  windowsWorkspaceDir: z.string().default('C:/workspace'),
  windowsPendingDir: z.string().default('C:/pending'),

  windowsAccountSync: boolFromEnv(true),
  /** C6：默认遵循 Windows 默认密码过期策略（42 天） */
  windowsPasswordNeverExpires: boolFromEnv(false),

  rdsHost: z.string().default(''),
  rdsPort: intFromEnv(3389),

  guacamoleUrl: z.string().default('https://guac.example.com/guacamole/#/client/'),
  /** A4 已废弃：仅为兼容旧 .env 保留，不再被读取 */
  guacamoleConnectionId: z.string().default('1'),
  guacDbUrl: z.string().default(''),
  guacamoleApiUrl: z.string().default(''),
  guacTokenTtlSeconds: intFromEnv(3540),
  guacTokenTimeoutSeconds: numberFromEnv(3.0),
  guacConnectionPrefix: z.string().default('windows-'),
  /** B13：默认 false —— jdbc extension 明文存连接密码，库泄露即凭据泄露 */
  guacRdpAutoLogin: boolFromEnv(false),
  guacRdpDomain: z.string().default(''),
  guacRdpSecurity: z.string().default('nla'),
  /** C7：默认 false —— 生产应使用有效证书 + NLA */
  guacRdpIgnoreCert: boolFromEnv(false),
  /** 已废弃（A3）：文件进出一律走 W: 盘 + 平台审批流程 */
  guacDriveRoot: z.string().default(''),
  guacRecordingRoot: z.string().default(''),

  psLoginScript: z.string().default(String.raw`\\fileserver\scripts\login.ps1`),
});

export type Settings = z.infer<typeof settingsSchema>;
export type AppEnv = Settings['appEnv'];

/* ---------------- 错误处理（替代 pydantic ValidationError） ---------------- */

export interface ConfigIssue {
  readonly field: string;
  readonly envName: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    const detail = issues
      .map((issue) => `  - ${issue.envName} (${issue.field}): ${issue.message}`)
      .join('\n');
    super(`配置加载失败：\n${detail}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const fromZodIssues = (zodIssues: ZodIssue[]): ConfigIssue[] =>
  zodIssues.map((issue) => {
    const field = issue.path.join('.');
    return { field, envName: toUpperSnake(field), message: issue.message };
  });

/* ---------------- 构建与加载 ---------------- */

export const DEFAULT_DOTENV_PATH = '.env';

export const loadDotenv = (path: string = DEFAULT_DOTENV_PATH): void => {
  dotenv.config({ path, encoding: 'utf8' });
};

export const createSettings = (source: EnvSource = process.env): Settings => {
  // 每次解析都重来：告警归属于这一次解析，避免跨调用串味（测试里会反复解析）
  pendingWarnings = [];
  const result = settingsSchema.safeParse(normalizeEnv(source));
  if (!result.success) throw new ConfigError(fromZodIssues(result.error.issues));
  return result.data;
};

/**
 * 复刻 pydantic-settings 的 extra=forbid：拒绝 .env 中的未知键。
 *
 * 只针对 .env 而不针对 process.env：pydantic-settings 的 env source 只枚举已声明
 * 字段（所以 PATH/HOME 不会报错），而 dotenv source 枚举文件全部键。
 * 本仓库曾因 .env 残留 RSTUDIO_PATH 等弃用键导致全站启动失败 —— 这个严格性是
 * 有意为之的安全护栏，不是 bug。
 */
export const assertKnownDotenvKeys = (path: string = DEFAULT_DOTENV_PATH): void => {
  const allowed = new Set(Object.keys(settingsSchema.shape).map(toUpperSnake));
  const unknown = Object.keys(dotenv.parse(readFileSync(path, 'utf8')))
    .map((key) => key.trim().toUpperCase())
    .filter((key) => !allowed.has(key));

  if (unknown.length > 0) {
    throw new ConfigError(unknown.map((envName) => ({
      field: '(unknown)',
      envName,
      message: '未知的 .env 配置项，请删除或加入 settingsSchema',
    })));
  }
};

/* ---------------- 进程级单例 ---------------- */

loadDotenv();

const initialSettings = createSettings();

/**
 * ⚠️ 消费方请始终以 `settings.xxx` 访问，**禁止解构**：
 * `const { jwtSecret } = settings` 会在覆盖发生前快照值，绕开 overrideSettings。
 */
export const settings: Settings = initialSettings;

export const getSettings = (): Settings => settings;

/** 测试钩子：原地覆盖（对应 conftest.py 直接赋值 / pytest monkeypatch.setattr） */
export const overrideSettings = (patch: Partial<Settings>): void => {
  Object.assign(settings, patch);
};

export const resetSettings = (): void => {
  Object.assign(settings, initialSettings);
};
