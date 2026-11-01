/**
 * JWT 签发与校验 —— app/auth.py:114-137
 *
 * 用 zod 收敛 claims：PyJWT 的 decode 返回裸 dict（payload.get("sub") 无任何类型保障）。
 */
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getSettings } from '../config/env.js';

export const accessTokenClaimsSchema = z.object({
  /** 用户 ID（PyJWT 里是 str(user_id)，保持字符串以兼容已签发 token） */
  sub: z.string().min(1),
  username: z.string().min(1),
  role: z.enum(['user', 'admin', 'superadmin']),
  /** 旧 token 无此字段视为版本 0，与当前版本（≥1）不匹配即拒绝 */
  pwdVer: z.number().int().nonnegative().default(0),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
}).passthrough();

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

const SUPPORTED_ALGORITHMS = new Set(['HS256', 'HS384', 'HS512']);

const assertSupportedAlgorithm = (algorithm: string): jwt.Algorithm => {
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
    throw new Error(`不支持的 JWT 算法: ${algorithm}（仅支持 ${[...SUPPORTED_ALGORITHMS].join('/')}）`);
  }
  return algorithm as jwt.Algorithm;
};

export interface CreateAccessTokenInput {
  readonly userId: number;
  readonly username: string;
  readonly role: 'user' | 'admin' | 'superadmin';
  readonly passwordVersion?: number;
}

/** 用 expiresIn 让库自己算 exp，不再手工 datetime.utcnow() + timedelta */
export const createAccessToken = ({
  userId, username, role, passwordVersion = 1,
}: CreateAccessTokenInput): string => {
  const { jwtSecret, jwtAlgorithm, jwtExpireHours } = getSettings();

  return jwt.sign(
    { sub: String(userId), username, role, pwd_ver: passwordVersion },
    jwtSecret,
    { algorithm: assertSupportedAlgorithm(jwtAlgorithm), expiresIn: `${jwtExpireHours}h` },
  );
};

/** 解码失败/过期/签名不符一律返回 null，由调用方统一转 401 */
export const verifyAccessToken = (token: string): AccessTokenClaims | null => {
  const { jwtSecret, jwtAlgorithm } = getSettings();

  let payload: unknown;
  try {
    payload = jwt.verify(token, jwtSecret, {
      algorithms: [assertSupportedAlgorithm(jwtAlgorithm)],
    });
  } catch {
    return null;
  }

  // PyJWT 的载荷键是 snake_case（pwd_ver），统一成 camelCase 后再校验
  const normalized = (payload ?? {}) as Record<string, unknown>;
  const parsed = accessTokenClaimsSchema.safeParse({
    ...normalized,
    pwdVer: normalized.pwd_ver ?? normalized.pwdVer ?? 0,
  });

  return parsed.success ? parsed.data : null;
};
