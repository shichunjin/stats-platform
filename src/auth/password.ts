/**
 * 密码哈希与强度策略 —— app/auth.py 对应部分
 *
 * 关键改动：
 *  1. pbkdf2 全部异步：Python 在线程池阻塞无所谓，Node 阻塞事件循环会拖垮全站
 *     （10 万次迭代约 50~100ms，同步版等于全站每秒只能处理 10 个登录）
 *  2. 迭代次数写入哈希串：pbkdf2$<iter>$<salt_b64>$<hash_b64>，支持平滑升级强度，
 *     且能解析旧的三段格式（视为 100000）
 */
import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

/** 历史哈希用的迭代次数（旧格式兼容） */
const LEGACY_ITERATIONS = 100_000;
/** 新哈希的迭代次数（OWASP 2023 对 PBKDF2-HMAC-SHA256 的建议量级） */
const DEFAULT_ITERATIONS = 600_000;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const DIGEST = 'sha256';

const pbkdf2Async = (
  password: string,
  salt: Buffer,
  iterations: number,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, KEY_BYTES, DIGEST, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });

/** 长度不等时 timingSafeEqual 会抛异常；长度本身不是秘密，先比长度再常量时间比较 */
const safeEqual = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && timingSafeEqual(a, b);

/** 常量时间比较字符串（演示账号密码），先哈希到定长避免长度侧信道 */
export const safeEqualString = (a: string, b: string): boolean =>
  safeEqual(
    createHash(DIGEST).update(a, 'utf8').digest(),
    createHash(DIGEST).update(b, 'utf8').digest(),
  );

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/** 四类字符：小写 / 大写 / 数字 / 特殊符号 */
const CATEGORY_PATTERNS: readonly RegExp[] = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/];
const REQUIRED_CATEGORIES = 3;
const WHITESPACE_PATTERN = /\s/;

/**
 * 按 Unicode 码点计数。
 * JS 的 str.length 是 UTF-16 码元数，emoji 会被算成 2；Python 的 len() 是码点数。
 */
const codePointLength = (value: string): number => [...value].length;

/** 校验密码强度，不合法抛 PasswordPolicyError（message 可直接返回前端） */
export const validatePasswordStrength = (
  password: string,
  username?: string | null,
): void => {
  const length = codePointLength(password);

  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(
      `密码长度必须为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`,
    );
  }
  if (WHITESPACE_PATTERN.test(password)) {
    throw new PasswordPolicyError('密码不能包含空格或换行');
  }

  const categories = CATEGORY_PATTERNS.filter((pattern) => pattern.test(password)).length;
  if (categories < REQUIRED_CATEGORIES) {
    throw new PasswordPolicyError('密码需至少包含大写字母、小写字母、数字、特殊符号中的三类');
  }

  if (username && codePointLength(username) >= 3
      && password.toLowerCase().includes(username.toLowerCase())) {
    throw new PasswordPolicyError('密码不能包含用户名');
  }
};

/** 生成 pbkdf2$<iterations>$<salt_b64>$<hash_b64> */
export const hashPassword = async (
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const derived = await pbkdf2Async(password, salt, iterations);
  return `pbkdf2$${iterations}$${salt.toString('base64')}$${derived.toString('base64')}`;
};

interface StoredHash {
  readonly iterations: number;
  readonly salt: Buffer;
  readonly expected: Buffer;
}

/** 解析存储串；兼容三段旧格式（迭代次数视为 100000） */
const parseStoredHash = (stored: string): StoredHash | null => {
  if (!stored.startsWith('pbkdf2$')) return null;

  const parts = stored.split('$');
  try {
    if (parts.length === 4) {
      const iterations = Number(parts[1]);
      if (!Number.isInteger(iterations) || iterations <= 0) return null;
      return {
        iterations,
        salt: Buffer.from(parts[2] as string, 'base64'),
        expected: Buffer.from(parts[3] as string, 'base64'),
      };
    }
    if (parts.length === 3) {
      return {
        iterations: LEGACY_ITERATIONS,
        salt: Buffer.from(parts[1] as string, 'base64'),
        expected: Buffer.from(parts[2] as string, 'base64'),
      };
    }
  } catch {
    return null;
  }
  return null;
};

export const verifyPasswordHash = async (
  password: string,
  stored: string | null,
): Promise<boolean> => {
  if (!stored) return false;

  const parsed = parseStoredHash(stored);
  if (parsed === null) return false;
  if (parsed.expected.length !== KEY_BYTES) return false;

  try {
    const derived = await pbkdf2Async(password, parsed.salt, parsed.iterations);
    return safeEqual(derived, parsed.expected);
  } catch {
    return false;
  }
};

/** 登录成功路径可用它判断是否需要静默升级哈希强度 */
export const readHashIterations = (stored: string | null): number | null =>
  (stored === null ? null : parseStoredHash(stored))?.iterations ?? null;

export const LEGACY_HASH_ITERATIONS = LEGACY_ITERATIONS;
export const CURRENT_HASH_ITERATIONS = DEFAULT_ITERATIONS;
