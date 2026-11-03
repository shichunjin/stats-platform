/**
 * 会话路由 —— app/routers/session.py + docs/multi-vm-desktop-plan.md 6.6
 * POST /session/connect
 *
 * 两条路径共用一个返回契约（前端零改动即可灰度）：
 *  - `desktop_mode='rds'`（默认）→ 共享桌面，逻辑与改造前完全一致；
 *  - `desktop_mode='vm'` → 用户专属 VM，连接按 VM 的 IP 单独指向。
 *
 * VM 路径下「连不上」不返回空 URL 而是抛 503 + 可执行文案：空 URL 在浏览器里
 * 表现为白屏，用户只会以为平台坏了；503 文案至少告诉他「等 20 秒」或「先改一次密码」。
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { HttpError, authenticate } from '../auth/guards.js';
import { recordAudit } from '../audit.js';
import { getSettings } from '../config/env.js';
import { deskInstances, remoteSessions, type DeskInstance, type User } from '../db/schema.js';
import { withSession } from '../db/session.js';
import { ensureDesktop, findActiveInstance, isVmMode, syncGuacForInstance } from '../desktop/service.js';
import { enqueueTask } from '../desktop/queue.js';
import { ensureUserConnection, getUserConnectionId, guacSyncEnabled } from '../integrations/guac.js';
import { getValidAuthToken } from '../integrations/guac-token.js';
import { provisionUserWorkspace, windowsSyncEnabled } from '../integrations/windows-account.js';
import { getClientIp } from '../security/rate-limit.js';
import { sessionOutSchema, toSessionOut } from '../schemas/index.js';
import { asRouteSchema } from '../plugins/validator.js';

/** 共享桌面（现状）：一人一专属连接，指向共享 RDS 主机 */
const connectSharedDesktop = async (user: User): Promise<number> => {
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
  return connectionId;
};

/** 唤醒：同一分钟内多次点击只入队一次（task_key 幂等），避免重复 start 打架 */
const enqueueWake = async (user: User, instance: DeskInstance): Promise<void> => {
  await enqueueTask({
    taskKey: `start:instance:${instance.id}:${Math.floor(Date.now() / 60_000)}`,
    type: 'start',
    instanceId: instance.id,
    vmId: instance.currentVmId,
    userId: user.id,
  });
};

/** 专属桌面：状态机到 guac 连接 ID */
const connectVmDesktop = async (user: User): Promise<number> => {
  // 幂等懒创建：首次点击在这里建实例并排队克隆
  const outcome = await ensureDesktop(user);
  if (outcome.mode !== 'vm') throw new HttpError(503, '云桌面未启用，请稍后重试');

  const active = await findActiveInstance(user.id);
  if (active === null) throw new HttpError(503, '专属桌面正在创建中，请稍候重试');

  const { instance, vm } = active;

  if (instance.status === 'awaiting_account') {
    throw new HttpError(
      503,
      '桌面账号尚未初始化：请先修改一次密码（用于开通桌面内的 Windows 账号），再点击连接',
    );
  }
  if (instance.status === 'failed' || instance.status === 'error') {
    throw new HttpError(503, '桌面创建失败，请联系管理员在管理端重建该桌面');
  }
  if (instance.status === 'destroyed') {
    throw new HttpError(503, '桌面已回收，请重新申请');
  }
  if (vm === null
    || instance.status === 'new' || instance.status === 'provisioning'
    || instance.status === 'configuring' || instance.status === 'booting'
    || instance.status === 'probing') {
    throw new HttpError(503, '专属桌面正在准备中，请 1~2 分钟后重试');
  }

  // 挂起/关机/无 IP：唤醒是异步的（几十秒），先让用户等一会儿再来
  if (instance.status === 'suspended' || vm.powerState !== 'running' || vm.primaryIp === null) {
    await enqueueWake(user, instance);
    throw new HttpError(503, '桌面正在唤醒，请 20 秒后重试');
  }

  const connectionId = await syncGuacForInstance(user.id, instance.id, user.username, {
    hostname: vm.primaryIp,
    port: vm.rdpPort,
  });
  if (connectionId === null) {
    throw new HttpError(503, '接入网关未就绪（GUAC_DB_URL 未配置或连接同步失败），请联系管理员');
  }

  await withSession(async (db) => {
    await db.db.update(deskInstances)
      .set({
        status: 'connected',
        lastConnectedAt: new Date(),
        connectCount: instance.connectCount + 1,
      })
      .where(eq(deskInstances.id, instance.id));
    await db.commit();
  });

  return connectionId;
};

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  /** 写会话记录 + 审计 + 拼免密 URL（两条路径共用，保证审计口径一致） */
  const openSession = async (
    request: FastifyRequest,
    user: User,
    connectionId: number,
    guacId: string,
  ): Promise<ReturnType<typeof toSessionOut>> => app.withDb(async (db) => {
    const [session] = await db.db.insert(remoteSessions).values({
      userId: user.id,
      guacIdentifier: guacId,
      status: 'active',
    }).returning();

    await recordAudit(db, {
      userId: user.id,
      action: 'session_connect',
      detail: `连接数据分析PC, guac_id=${guacId}, connection_id=${connectionId}`,
      ipAddr: getClientIp(request),
    });
    await db.commit();

    let guacUrl = `${getSettings().guacamoleUrl}${connectionId}`;
    const authToken = await getValidAuthToken(db, user.id);
    if (authToken) {
      guacUrl = `${guacUrl}?token=${encodeURIComponent(authToken)}`;
    }

    return toSessionOut(session!, guacUrl);
  });

  app.post('/session/connect', {
    schema: asRouteSchema({ response: { 200: sessionOutSchema } }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const guacId = `windows-${user.username}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

    const connectionId = isVmMode(user)
      ? await connectVmDesktop(user)
      : await connectSharedDesktop(user);

    return openSession(request, user, connectionId, guacId);
  });
};
