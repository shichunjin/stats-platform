/**
 * .env 解析 —— 复刻 python-dotenv 语义，替换 npm `dotenv`
 *
 * 为什么不用 npm dotenv：它对**未加引号**的值无条件把 `#` 当作注释起始，
 * 于是
 *   GUACAMOLE_URL=https://guac.example.com/guacamole/#/client/
 * 会被解析成 `https://guac.example.com/guacamole/`。`/session/connect` 再拼上
 * 连接 ID 得到 `.../guacamole/3`，浏览器把 `/3` 真发出去，Tomcat 直接 404
 * （若 `#` 保留，浏览器只会请求 `/guacamole/`，由 Guacamole 前端路由接管）。
 *
 * python-dotenv 只在 `#` 位于行首或前面有空白时才当注释（`A=1#2` → `1#2`，
 * `B=1 #c` → `1`），所以 Python 版一直是好的。这里严格对齐该规则，
 * 保证同一个 .env 文件在两套实现下解析结果一致。
 *
 * 解析规则（与 python-dotenv 对齐）：
 *  - 空行、`#` 开头的整行注释跳过
 *  - 支持可选 `export ` 前缀
 *  - 值可用 ' " ` 包裹，双引号内支持 \n \r \t \\ \" 转义与跨行
 *  - 未加引号的值：去掉首尾空白，遇「空白 + #」截断注释，其余原样保留
 */
import { readFileSync } from 'node:fs';

type EnvRecord = Record<string, string>;

const LINE_BREAK = /\r\n|\n|\r/;
const KEY_VALUE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*([\s\S]*)$/;
/** 未加引号值里的注释起始：必须有空白在前（python-dotenv 语义） */
const UNQUOTED_COMMENT = /\s+#/;
const QUOTE_CHARS = new Set(['"', '\'', '`']);

/** 双引号值内的转义序列（python-dotenv 支持的最小集） */
const unescapeDoubleQuoted = (value: string): string =>
  value.replace(/\\([nrt\\"])/g, (_match, char: string) => {
    switch (char) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return char;
    }
  });

const decodeQuoted = (quote: string, value: string): string =>
  (quote === '"' ? unescapeDoubleQuoted(value) : value);

/**
 * 找与首字符配对的闭合引号下标；未闭合返回 -1（进入多行值）。
 * 单引号内不做转义（与 python-dotenv / POSIX shell 一致）。
 */
const findClosingQuote = (raw: string, quote: string): number => {
  for (let index = 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '\\' && quote !== '\'') {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
};

/** 解析 .env 文本。未知行静默忽略（python-dotenv 同样不因脏行报错） */
export const parseDotenv = (content: string): EnvRecord => {
  const result: EnvRecord = {};
  const lines = content.split(LINE_BREAK);
  let pending: { key: string; quote: string; parts: string[] } | null = null;

  for (const line of lines) {
    // 多行值内部：一直吃到闭合引号为止
    if (pending !== null) {
      const end = findClosingQuote(line, pending.quote);
      if (end < 0) {
        pending.parts.push(line);
        continue;
      }
      pending.parts.push(line.slice(0, end));
      result[pending.key] = decodeQuoted(pending.quote, pending.parts.join('\n'));
      pending = null;
      continue;
    }

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const match = KEY_VALUE.exec(trimmed);
    if (match === null) continue;

    const key = match[1] as string;
    const rawValue = match[2] as string;

    if (QUOTE_CHARS.has(rawValue.charAt(0))) {
      const quote = rawValue.charAt(0);
      const end = findClosingQuote(rawValue, quote);
      if (end < 0) {
        pending = { key, quote, parts: [rawValue.slice(1)] };
        continue;
      }
      result[key] = decodeQuoted(quote, rawValue.slice(1, end));
      continue;
    }

    const comment = UNQUOTED_COMMENT.exec(rawValue);
    result[key] = (comment === null ? rawValue : rawValue.slice(0, comment.index)).trim();
  }

  // 未闭合的多行值：python-dotenv 会一直取到文件末尾
  if (pending !== null) {
    result[pending.key] = decodeQuoted(pending.quote, pending.parts.join('\n'));
  }

  return result;
};

/** 读取 .env 文件；文件不存在返回空对象（与 dotenv.config 的静默语义一致） */
export const readDotenvFile = (path: string): EnvRecord => {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parseDotenv(content);
};

/**
 * 把解析结果写入目标对象（默认 process.env）。
 * 默认不覆盖已有值 —— 真实环境变量优先级高于 .env（pydantic-settings 语义）。
 */
export const applyDotenv = (
  parsed: EnvRecord,
  target: Record<string, string | undefined> = process.env,
  override = false,
): void => {
  const entries = Object.entries(parsed)
    .filter(([key]) => override || target[key] === undefined);

  for (const [key, value] of entries) {
    // process.env 只能原地写，没法用「返回新对象」代替
    // eslint-disable-next-line no-param-reassign
    target[key] = value;
  }
};
