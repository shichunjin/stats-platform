/**
 * Guacamole authToken 换取与缓存（免密直连）—— app/guac_token.py
 *
 * 登录成功后用本次输入的明文密码调 Guacamole REST API `POST /api/tokens`
 * 换取 authToken，按用户缓存到 guac_auth_tokens 表；
 * /session/connect 返回 `.../#/client/{id}?token=<authToken>` 跳过登录页。
 *
 * 设计约束（与 Python 版一致）：
 *  - 只缓存 authToken，不保存用户密码
 *  - Guacamole 未就绪/超时/账号未同步时仅记日志，不影响平台登录
 *  - 令牌过期后自动清除，连接接口回退为普通地址
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getSettings } from '../config/env.js';
import { guacAuthTokens } from '../db/schema.js';
import type { DbSession } from '../db/session.js';
import { guacSyncEnabled } from './guac.js';

/** Guacamole REST API 基址：显式配置优先，否则由 GUACAMOLE_URL 推导 */
export const guacApiBase = (): string => {
  const { guacamoleApiUrl, guacamoleUrl } = getSettings();
  if (guacamoleApiUrl) return guacamoleApiUrl.replace(/\/$/, '');
  return `${guacamoleUrl.split('/#')[0]!.replace(/\/$/, '')}/api`;
};

const tokenResponseSchema = z.object({ authToken: z.string().min(1) });

/** 换取 authToken；失败返回 null，不抛异常（网络异常不应阻断平台登录） */
export const fetchAuthToken = async (
  username: string,
  password: string,
): Promise<string | null> => {
  const { guacTokenTimeoutSeconds } = getSettings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), guacTokenTimeoutSeconds * 1_000);

  try {
    const response = await fetch(`${guacApiBase()}/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }).toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.info('[guac-token] Guacamole 未返回令牌 user=%s status=%s', username, response.status);
      return null;
    }

    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.warn('[guac-token] Guacamole 令牌响应解析失败 user=%s', username);
      return null;
    }
    return parsed.data.authToken;
  } catch (error) {
    console.warn('[guac-token] Guacamole 免密令牌获取失败 user=%s: %s', username, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** 写入/覆盖用户的令牌缓存（调用方负责 commit） */
export const cacheAuthToken = async (
  db: DbSession,
  userId: number,
  authToken: string,
): Promise<void> => {
  const { guacTokenTtlSeconds } = getSettings();
  const expiresAt = new Date(Date.now() + guacTokenTtlSeconds * 1_000);

  await db.db.insert(guacAuthTokens)
    .values({ userId, authToken, expiresAt })
    .onConflictDoUpdate({
      target: guacAuthTokens.userId,
      set: { authToken, expiresAt },
    });
};

/** 登录/改密成功后 best-effort 换取并缓存令牌（任何异常都不外抛） */
export const rememberLoginToken = async (
  db: DbSession,
  userId: number,
  username: string,
  password: string,
): Promise<void> => {
  if (!guacSyncEnabled()) return;

  const token = await fetchAuthToken(username, password);
  if (!token) return;

  try {
    await cacheAuthToken(db, userId, token);
    await db.commit();
  } catch (error) {
    await db.rollback().catch(() => undefined);
    console.warn('[guac-token] 缓存 Guacamole 令牌失败 user=%s: %s', username, error);
  }
};

/** 读取未过期的令牌；已过期则清除并返回 null */
export const getValidAuthToken = async (
  db: DbSession,
  userId: number,
): Promise<string | null> => {
  const [row] = await db.db.select()
    .from(guacAuthTokens)
    .where(eq(guacAuthTokens.userId, userId))
    .limit(1);

  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    await db.db.delete(guacAuthTokens).where(eq(guacAuthTokens.userId, userId));
    await db.commit();
    return null;
  }

  return row.authToken;
};
