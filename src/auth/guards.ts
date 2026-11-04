/**
 * 认证守卫 —— 替代 app/auth.py 的 get_current_user / require_admin / require_superadmin
 *
 * FastAPI 用 Depends 做依赖注入；Fastify 用 preHandler hook + 请求装饰器。
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { users, type User } from '../db/schema.js';
import { verifyAccessToken, type AccessTokenClaims } from './token.js';

declare module 'fastify' {
  // 模块增强：这里的 FastifyRequest 与顶部 import 同名，ESLint 误判为 shadow
  // eslint-disable-next-line @typescript-eslint/no-shadow
  interface FastifyRequest {
    user?: User;
    tokenClaims?: AccessTokenClaims;
  }
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const unauthorized = (message = '无法验证凭据'): HttpError =>
  new HttpError(401, message, { 'WWW-Authenticate': 'Bearer' });

/** 替代 OAuth2PasswordBearer(auto_error=False)：取不到就返回 null，不抛 */
const parseBearerToken = (header: string | undefined): string | null => {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
};

/** 认证 preHandler：挂载 request.user */
export const authenticate = async (request: FastifyRequest): Promise<void> => {
  const token = parseBearerToken(request.headers.authorization);
  if (token === null) throw unauthorized();

  const claims = verifyAccessToken(token);
  if (claims === null) throw unauthorized();

  const userId = Number(claims.sub);
  if (!Number.isInteger(userId)) throw unauthorized();

  const user = await request.server.withDb(async (db) => {
    const [row] = await db.db.select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.isActive, true)))
      .limit(1);
    return row;
  });

  if (!user) throw unauthorized();

  // B2：改密后旧 JWT 立即失效（旧 token 无 pwd_ver 视为 0，与当前版本不匹配即拒绝）
  if (claims.pwdVer !== (user.passwordVersion ?? 1)) {
    throw unauthorized('凭据已过期，请重新登录');
  }

  request.user = user;
  request.tokenClaims = claims;
};

/** 管理员守卫：superadmin 天然拥有管理员权限 */
export const requireAdmin = async (request: FastifyRequest): Promise<void> => {
  if (!request.user) throw unauthorized();
  if (request.user.role !== 'admin' && request.user.role !== 'superadmin') {
    throw new HttpError(403, '需要管理员权限');
  }
};

export const requireSuperadmin = async (request: FastifyRequest): Promise<void> => {
  if (!request.user) throw unauthorized();
  if (request.user.role !== 'superadmin') {
    throw new HttpError(403, '需要超级管理员权限');
  }
};

/**
 * 统一错误出口（替代 FastAPI 自动处理 HTTPException）
 *
 * 额外处理一件事：Fastify 的 schema 校验失败默认返回 **400**，而 FastAPI 用 **422**
 * （Unprocessable Entity）。前端按 422 分支处理表单校验错误，因此这里做一次映射，
 * 保证 wire 行为与原 Python 一致。
 */
export const httpErrorHandler = (
  error: unknown,
  _request: FastifyRequest,
  reply: FastifyReply,
): void => {
  if (error instanceof HttpError) {
    void reply.code(error.statusCode).headers(error.headers).send({ detail: error.message });
    return;
  }

  const { code } = error as { code?: unknown };
  if (error instanceof Error && code === 'FST_ERR_VALIDATION') {
    void reply.code(422).send({ detail: error.message });
    return;
  }

  /**
   * DesktopError：DMS 的**配置类**失败（模板 provider 对不上、没有可用模板…）。
   *
   * 这类错误抛到默认处理器会变成 500「Internal Server Error」，把真因吞掉——
   * 而它恰恰是运维最需要看见的那句话（切 ECS 后模板还是 proxmox 就属于这一类）。
   * 用鸭子类型判断而不是 import：guards 是底层模块，不该反向依赖 desktop 业务。
   */
  const desktop = error as { name?: string; code?: string; message?: string };
  if (error instanceof Error && desktop.name === 'DesktopError') {
    void reply.code(503).send({
      detail: desktop.message ?? '云桌面暂不可用',
      code: desktop.code ?? 'DESKTOP_UNAVAILABLE',
    });
    return;
  }

  throw error;
};
