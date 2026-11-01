/**
 * 会话路由 —— app/routers/session.py
 * POST /session/connect
 */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { HttpError, authenticate } from '../auth/guards.js';
import { recordAudit } from '../audit.js';
import { remoteSessions, type User } from '../db/schema.js';
import { ensureUserConnection, getUserConnectionId, guacSyncEnabled } from '../integrations/guac.js';
import { getValidAuthToken } from '../integrations/guac-token.js';
import { provisionUserWorkspace, windowsSyncEnabled } from '../integrations/windows-account.js';
import { getSettings } from '../config/env.js';
import { getClientIp } from '../security/rate-limit.js';
import { sessionOutSchema, toSessionOut } from '../schemas/index.js';
import { asRouteSchema } from '../plugins/validator.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.post('/session/connect', {
    schema: asRouteSchema({ response: { 200: sessionOutSchema } }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const guacId = `windows-${user.username}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    // 老账号补偿：私有目录可能缺失。幂等补建；失败仅记日志，不阻断远程连接。
    if (windowsSyncEnabled()) {
      try {
        await provisionUserWorkspace(user.username);
      } catch (error) {
        console.warn('[session] 工作区自动开通失败（不阻断连接）user=%s: %s', user.username, error);
      }
    }

    // A4：未启用 JDBC 同步时无法保证一人一专属连接，拒绝建立会话（防会话串号）
    if (!guacSyncEnabled()) {
      throw new HttpError(
        503,
        '远程桌面服务未启用用户级连接同步（GUAC_DB_URL 未配置），已拒绝共享连接，请联系管理员',
      );
    }

    let connectionId = await getUserConnectionId(user.username);
    if (connectionId === null) {
      // 老用户补偿：账号已同步但专属连接缺失
      connectionId = await ensureUserConnection(user.username);
    }
    if (connectionId === null) {
      throw new HttpError(503, '远程桌面环境尚未就绪，请修改一次密码或联系管理员同步账号');
    }
    const connectionRef = String(connectionId);

    return app.withDb(async (db) => {
      const [session] = await db.db.insert(remoteSessions).values({
        userId: user.id,
        guacIdentifier: guacId,
        status: 'active',
      }).returning();

      await recordAudit(db, {
        userId: user.id,
        action: 'session_connect',
        detail: `连接数据分析PC, guac_id=${guacId}, connection_id=${connectionRef}`,
        ipAddr: getClientIp(request),
      });
      await db.commit();

      let guacUrl = `${getSettings().guacamoleUrl}${connectionRef}`;
      const authToken = await getValidAuthToken(db, user.id);
      if (authToken) {
        guacUrl = `${guacUrl}?token=${encodeURIComponent(authToken)}`;
      }

      return toSessionOut(session!, guacUrl);
    });
  });
};
