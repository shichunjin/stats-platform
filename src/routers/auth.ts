/**
 * 认证路由 —— app/routers/auth.py
 * POST /auth/register, POST /auth/login, GET /auth/me, POST /auth/change-password
 */
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { HttpError, authenticate } from '../auth/guards.js';
import { isDemoAccount, matchesDemoPassword } from '../auth/demo.js';
import {
  PasswordPolicyError, hashPassword, validatePasswordStrength, verifyPasswordHash,
} from '../auth/password.js';
import { createAccessToken } from '../auth/token.js';
import { recordAudit } from '../audit.js';
import { users, type User } from '../db/schema.js';
import { isVmMode, notifyVmPasswordChange } from '../desktop/service.js';
import { rememberLoginToken } from '../integrations/guac-token.js';
import { upsertGuacUser } from '../integrations/guac.js';
import { syncWindowsUser } from '../integrations/windows-account.js';
import { checkAuthRateLimit, getClientIp } from '../security/rate-limit.js';
import {
  changePasswordRequestSchema, loginRequestSchema, messageResponseSchema,
  registerRequestSchema, registerResponseSchema, tokenResponseSchema,
  toUserOut, userOutSchema,
  type ChangePasswordRequest, type LoginRequest, type RegisterRequest,
} from '../schemas/index.js';
import { asRouteSchema } from '../plugins/validator.js';

/** 限流 -> 429（对应 Python 的 Depends(rate_limit_auth)） */
const authRateLimit = async (request: FastifyRequest): Promise<void> => {
  const verdict = checkAuthRateLimit(request);
  if (verdict.blocked) {
    throw new HttpError(429, verdict.message ?? '请求过于频繁', {
      'Retry-After': String(verdict.retryAfterSeconds ?? 1),
    });
  }
};

const withPasswordPolicy = (fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PasswordPolicyError) throw new HttpError(422, error.message);
    throw error;
  }
};

/** 外部系统同步失败统一转 502（平台不产生半完成账号） */
const syncExternal = async (
  label: string,
  fn: () => Promise<unknown>,
  tail: string,
): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `${label}：${reason}（${tail}）`);
  }
};

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: RegisterRequest }>('/auth/register', {
    schema: asRouteSchema({ body: registerRequestSchema, response: { 200: registerResponseSchema } }),
    preHandler: [authRateLimit],
  }, async (request, reply) => {
    const { username, password, display_name: displayName } = request.body;

    return app.withDb(async (db) => {
      if (isDemoAccount(username)) {
        throw new HttpError(400, `用户名 '${username}' 已被占用`);
      }
      const [existing] = await db.db.select({ id: users.id })
        .from(users).where(eq(users.username, username)).limit(1);
      if (existing) throw new HttpError(400, `用户名 '${username}' 已被占用`);

      // 强度前置校验（对齐 Windows 复杂度策略，避免同步到云主机时才被拒）
      withPasswordPolicy(() => validatePasswordStrength(password, username));

      // 外部系统同步顺序：Windows 本地账号 → Guacamole → 平台账号。
      // 三者按用户名幂等，任何一步失败都整体失败（502）。
      await syncExternal('Windows 账号同步失败', () => syncWindowsUser(username, password), '平台账号未创建，可修正后重试');
      await syncExternal('Guacamole 用户同步失败', () => upsertGuacUser(username, password), '平台账号未创建，可修正后重试');

      const [created] = await db.db.insert(users).values({
        username,
        displayName: displayName ?? username,
        role: 'user',
        isActive: true,
        passwordHash: await hashPassword(password),
      }).returning();

      await recordAudit(db, {
        userId: created!.id,
        action: 'register',
        detail: `新用户注册: ${created!.username}`,
        ipAddr: getClientIp(request),
      });

      await db.commit();

      return reply.send({
        id: created!.id,
        username: created!.username,
        display_name: created!.displayName,
        role: created!.role,
        message: '注册成功，请使用账号密码登录',
      });
    });
  });

  app.post<{ Body: LoginRequest }>('/auth/login', {
    schema: asRouteSchema({ body: loginRequestSchema, response: { 200: tokenResponseSchema } }),
    preHandler: [authRateLimit],
  }, async (request) => {
    const { username, password } = request.body;
    const clientIp = getClientIp(request);

    return app.withDb(async (db) => {
      const [user] = await db.db.select().from(users).where(eq(users.username, username)).limit(1);

      if (!user) {
        await recordAudit(db, {
          userId: null,
          action: 'login',
          detail: `登录失败（用户不存在）: ${username}`,
          ipAddr: clientIp,
          status: 'failed',
        });
        await db.commit();
        throw new HttpError(401, '用户名或密码错误');
      }

      if (!user.isActive) throw new HttpError(403, '账号已被禁用');

      const ok = matchesDemoPassword(username, password)
        || await verifyPasswordHash(password, user.passwordHash);

      if (!ok) {
        await recordAudit(db, {
          userId: user.id,
          action: 'login',
          detail: `登录失败（密码错误）: ${username}`,
          ipAddr: clientIp,
          status: 'failed',
        });
        await db.commit();
        throw new HttpError(401, '用户名或密码错误');
      }

      await recordAudit(db, {
        userId: user.id,
        action: 'login',
        detail: `用户 ${user.username} 登录`,
        ipAddr: clientIp,
      });
      await db.commit();

      // 免密直连：顺带换取 Guacamole authToken（best-effort，失败不影响本次登录）
      // 注意：commit 之后会话已结束，需另开会话写令牌缓存
      await app.withDb(async (tokenDb) => {
        await rememberLoginToken(tokenDb, user.id, user.username, password);
      });

      // 第四端（VM 本地账号）：登录是唯一还能拿到明文密码的自动化时机，
      // 顺手补上 A16 的缺口（注册后首次登录即完成桌面账号初始化）。
      // 已同步过（password_version 一致）时内部会直接跳过，不重复跑 SSH。**非阻断**。
      if (isVmMode(user)) void notifyVmPasswordChange(user.id, password);

      return {
        access_token: createAccessToken({
          userId: user.id,
          username: user.username,
          role: user.role,
          passwordVersion: user.passwordVersion ?? 1,
        }),
        token_type: 'bearer',
      };
    });
  });

  app.get('/auth/me', {
    schema: asRouteSchema({ response: { 200: userOutSchema } }),
    preHandler: [authenticate],
  }, async (request) => toUserOut(request.user as User));

  app.post<{ Body: ChangePasswordRequest }>('/auth/change-password', {
    schema: asRouteSchema({ body: changePasswordRequestSchema, response: { 200: messageResponseSchema } }),
    preHandler: [authenticate],
  }, async (request) => {
    const { old_password: oldPassword, new_password: newPassword } = request.body;
    const user = request.user as User;

    if (isDemoAccount(user.username)) {
      throw new HttpError(400, '演示账号密码由环境变量管理，不能在线修改');
    }

    return app.withDb(async (db) => {
      const ok = matchesDemoPassword(user.username, oldPassword)
        || await verifyPasswordHash(oldPassword, user.passwordHash);
      if (!ok) throw new HttpError(400, '原密码错误');

      withPasswordPolicy(() => validatePasswordStrength(newPassword, user.username));

      // 外部系统先改：Windows → Guacamole，全部成功后才改平台密码，保证三端一致
      await syncExternal('Windows 账号同步失败', () => syncWindowsUser(user.username, newPassword), '平台密码未修改');
      await syncExternal('Guacamole 密码同步失败', () => upsertGuacUser(user.username, newPassword), '平台密码未修改');

      await db.db.update(users)
        .set({
          passwordHash: await hashPassword(newPassword),
          passwordVersion: (user.passwordVersion ?? 1) + 1,
        })
        .where(eq(users.id, user.id));

      await recordAudit(db, {
        userId: user.id,
        action: 'change_password',
        detail: `用户 ${user.username} 修改密码`,
        ipAddr: getClientIp(request),
      });
      await db.commit();

      await app.withDb(async (tokenDb) => {
        await rememberLoginToken(tokenDb, user.id, user.username, newPassword);
      });

      // 第四端：用户专属 VM 里的 Windows 本地账号（方案 A′）。
      // **非阻断** —— VM 可能离线/挂起（唤醒要一分钟），绝不能让它卡住改密。
      // 失败时 password_version 保持落后，下次开机把实例判成 awaiting_account 引导再改一次。
      if (isVmMode(user)) void notifyVmPasswordChange(user.id, newPassword);

      return { message: '密码修改成功，Windows 云桌面与 Guacamole 登录密码已同步' };
    });
  });
};
