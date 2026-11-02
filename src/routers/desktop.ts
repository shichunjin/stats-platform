/**
 * 云桌面路由 —— docs/multi-vm-desktop-plan.md 6.6
 *
 * `POST /desktop/ensure` 是前端唯一的入口：**幂等**（重复调用不会多建 VM，
 * 靠 `uq_desk_instances_active_user` 与任务 `task_key` 双重保证），
 * **异步**（VM 克隆要几分钟，这里只负责受理并返回状态）。
 *
 * 灰度语义（很重要）：全局开关关闭、或用户 `desktop_mode='rds'` 时，
 * 接口返回 `mode='rds'` 而不是报错 —— 前端据此继续走老的 `/session/connect`，
 * 这样开关随时可以关回去，不需要改前端。
 */
import type { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../auth/guards.js';
import { recordAudit } from '../audit.js';
import { getSettings } from '../config/env.js';
import type { User } from '../db/schema.js';
import { ensureDesktop, findActiveInstance, isVmMode } from '../desktop/service.js';
import { getClientIp } from '../security/rate-limit.js';
import { desktopEnsureOutSchema, toDesktopEnsureOut } from '../schemas/index.js';
import { asRouteSchema } from '../plugins/validator.js';

const asWire = (input: {
  readonly mode: 'rds' | 'vm';
  readonly instanceId?: number | null;
  readonly status?: string | null;
  readonly created?: boolean;
  readonly taskId?: number | null;
  readonly vmIp?: string | null;
}): ReturnType<typeof toDesktopEnsureOut> => toDesktopEnsureOut({
  mode: input.mode,
  instanceId: input.instanceId ?? null,
  status: input.status ?? null,
  created: input.created ?? false,
  taskId: input.taskId ?? null,
  vmIp: input.vmIp ?? null,
});

export const desktopRoutes: FastifyPluginAsync = async (app) => {
  app.post('/desktop/ensure', {
    schema: asRouteSchema({ response: { 200: desktopEnsureOutSchema } }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const outcome = await ensureDesktop(user);

    if (outcome.mode === 'rds') return asWire({ mode: 'rds' });

    // 只有「真的新建了实例」才写审计：状态查询类调用不刷审计日志
    if (outcome.created) {
      await app.withDb(async (db) => {
        await recordAudit(db, {
          userId: user.id,
          action: 'desktop_ensure',
          detail: `申请专属云桌面, instance_id=${outcome.instanceId}, task_id=${outcome.taskId}`,
          ipAddr: getClientIp(request),
        });
        await db.commit();
      });
    }

    return asWire({
      mode: 'vm',
      instanceId: outcome.instanceId,
      status: outcome.status,
      created: outcome.created,
      taskId: outcome.taskId,
      vmIp: outcome.vmIp,
    });
  });

  /**
   * 状态查询：只读，不触发创建。
   * 前端在 ensure 之后轮询它等 VM 就绪（ready / awaiting_account 都算可连）。
   */
  app.get('/desktop/status', {
    schema: asRouteSchema({ response: { 200: desktopEnsureOutSchema } }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    if (!isVmMode(user) || !getSettings().desktopEnabled) return asWire({ mode: 'rds' });

    const active = await findActiveInstance(user.id);
    if (!active) return asWire({ mode: 'vm' });

    return asWire({
      mode: 'vm',
      instanceId: active.instance.id,
      status: active.instance.status,
      vmIp: active.vm?.primaryIp ?? null,
    });
  });
};
