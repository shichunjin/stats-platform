/**
 * 云桌面管理端路由 —— docs/multi-vm-desktop-plan.md 6.6 / 7.2 / 7.6 / 7.8
 *
 * 面向运维：只做「看清楚 + 强制干预」，不做业务开通（那是 `/desktop/ensure`）。
 *
 *   GET  /admin/desktops                     实例列表（含 VM/模板/配额/最近任务，一行看全）
 *   GET  /admin/desktop-tasks                任务队列（排查卡单的第一入口）
 *   POST /admin/desktops/:instance_id/suspend  强制挂起
 *   POST /admin/desktops/:instance_id/recycle  强制回收（销毁 VM，保留实例行）
 *   POST /admin/desktops/:instance_id/rebuild  从模板重建（规格按当前配额重算）
 *   POST /admin/desktops/:instance_id/probe    立即探活
 *   POST /admin/desktop-tasks/:task_id/retry   重跑失败任务
 *   GET  /admin/desktop-templates            模板列表（只读：模板在 Proxmox/ECS 侧建，这里只是登记）
 *   POST /admin/desktop-templates            登记/更新模板（provider 必须与当前 DESKTOP_PROVIDER 一致）
 *   GET  /admin/desktop-quotas               配额列表
 *   PUT  /admin/desktop-quotas/:quota_id     改配额（规格分档的唯一入口）
 *
 * 两条刻意的设计：
 *  1. **不看灰度开关**。`desktopEnabled=false` 时用户的 `/desktop/ensure` 会被挡掉，
 *     但运维仍要能收尾存量 VM（强制回收、重跑卡住的任务）—— 否则一关开关就留下孤儿 VM。
 *  2. **动作一律入队，不同步执行**。克隆/关机是分钟级，HTTP 里同步做必然超时；
 *     这里只负责「可靠地排进 `desktop_tasks`」，执行交给 worker。
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { HttpError, authenticate, requireAdmin } from '../auth/guards.js';
import { getSettings } from '../config/env.js';
import {
  deskInstances, desktopQuotas, desktopTemplates, desktopTasks, desktopVms, users,
  type DeskInstanceStatus, type DesktopTask, type User,
} from '../db/schema.js';
import { enqueueTask } from '../desktop/queue.js';
import { asRouteSchema } from '../plugins/validator.js';
import {
  desktopActionOutSchema,
  desktopAdminOutSchema,
  desktopQuotaOutSchema,
  desktopTaskOutSchema,
  desktopTemplateOutSchema,
  toDesktopAdminOut,
  toDesktopQuotaOut,
  toDesktopTaskOut,
  toDesktopTemplateOut,
} from '../schemas/index.js';
import { getClientIp } from '../security/rate-limit.js';

const paginationSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0)
    .openapi({ description: '跳过条数' }),
  limit: z.coerce.number().int().min(1).max(200).default(50)
    .openapi({ description: '返回条数上限（最大 200）' }),
});

const instanceQuerySchema = paginationSchema.extend({
  status: z.string().optional().openapi({ description: '按实例状态过滤（new/ready/idle/destroyed…）' }),
  user_id: z.coerce.number().int().positive().optional()
    .openapi({ description: '按用户过滤' }),
  desktop_mode: z.enum(['rds', 'vm']).optional()
    .openapi({ description: '按用户灰度模式过滤' }),
});

const taskQuerySchema = paginationSchema.extend({
  status: z.string().optional().openapi({ description: 'pending/running/success/failed/error/cancelled' }),
  type: z.string().optional().openapi({ description: 'create/start/probe/suspend/recycle…' }),
  instance_id: z.coerce.number().int().positive().optional(),
});

const instanceParamsSchema = z.object({
  instance_id: z.coerce.number().int().positive().openapi({ description: '桌面实例 ID' }),
}).strict();

const taskParamsSchema = z.object({
  task_id: z.coerce.number().int().positive().openapi({ description: '任务 ID' }),
}).strict();

const quotaParamsSchema = z.object({
  quota_id: z.coerce.number().int().positive().openapi({ description: '配额 ID' }),
}).strict();

/**
 * 配额更新：全部可选（PBUT 语义），null 表示「恢复为取模板基线」（仅 default_* 有意义）。
 * 上限类字段不允许置 null —— 那等同于取消限制，很容易误操作。
 */
const quotaUpdateSchema = z.object({
  default_vcpu: z.number().int().min(1).max(128).nullable().optional(),
  default_memory_mb: z.number().int().min(512).max(262_144).nullable().optional(),
  max_vcpu: z.number().int().min(1).max(128).optional(),
  max_memory_mb: z.number().int().min(512).max(262_144).optional(),
  max_disk_gb: z.number().int().min(20).max(4_096).optional(),
  max_instances: z.number().int().min(1).max(10).optional(),
  max_daily_hours: z.number().min(0).max(24).nullable().optional(),
  max_idle_days: z.number().int().min(1).max(365).optional(),
  rebuild_after_days: z.number().int().min(1).max(1_825).optional(),
  destroy_after_idle_days: z.number().int().min(1).max(365).optional(),
  allow_rebuild: z.boolean().optional(),
  template_id: z.number().int().positive().nullable().optional(),
}).strict();

/**
 * 模板登记（upsert by code）。
 *
 * 为什么需要写接口：`provider_ref` 的语义随 provider 变 —— Proxmox 是 'pve1/9001'，
 * ECS 是自定义镜像 ID 'm-xxx'。切 ECS 时如果只能手写 SQL，运维很容易填错格式，
 * 而错误要到第一次 RunInstances 才暴露（报的是镜像不存在，指不到病根）。
 */
const templateUpsertSchema = z.object({
  code: z.string().min(1).max(64).openapi({ description: "模板编码，如 'win2022-stats-v1'（唯一，重复即更新）" }),
  name: z.string().min(1).max(128),
  provider: z.enum(['proxmox', 'libvirt', 'vmware', 'hyperv', 'ecs'])
    .openapi({ description: '必须等于当前 .env 的 DESKTOP_PROVIDER' }),
  provider_ref: z.string().min(1).max(128)
    .openapi({ description: "Proxmox 'pve1/9001' / ECS 自定义镜像 ID 'm-xxx'" }),
  provider_node: z.string().max(64).optional(),
  os_type: z.string().min(1).max(32).default('windows'),
  os_version: z.string().max(64).optional(),
  vcpu: z.number().int().min(1).max(128),
  memory_mb: z.number().int().min(512).max(262_144),
  disk_gb: z.number().int().min(20).max(4_096),
  storage: z.string().max(64).optional(),
  guest_username: z.string().max(64).optional(),
  status: z.enum(['active', 'disabled', 'building', 'error']).default('active'),
  is_default: z.boolean().default(false),
  max_instances: z.number().int().min(1).max(10).optional(),
}).strict();

/** 可挂起的状态：只有「真的跑着或可连」的实例才值得挂起，其余状态入队只会白跑一次 */
const SUSPENDABLE: readonly DeskInstanceStatus[] = [
  'ready', 'connected', 'idle', 'awaiting_account',
];

/**
 * 可回收：除终态（destroyed/error）外的全部状态 —— 卡在 provisioning 的僵尸实例也该能清掉。
 * rebuild 复用同一份清单：它比回收多一步克隆，多的那一步由任务自己校验（模板可用性 / 配额开关）。
 */
const RECYCLABLE: readonly DeskInstanceStatus[] = [
  'new', 'provisioning', 'configuring', 'booting', 'probing',
  'ready', 'awaiting_account', 'connected', 'idle', 'suspended', 'failed',
];

type ActionKind = 'suspend' | 'recycle' | 'rebuild' | 'probe';

/** 分钟级时间戳：同一次点击重复提交会被 task_key 幂等掉，但隔一分钟可以再来一次 */
const minuteKey = (): number => Math.floor(Date.now() / 60_000);

const assertInstanceStatus = (
  status: DeskInstanceStatus,
  action: ActionKind,
): void => {
  if (action === 'probe') return;
  const allowed = action === 'suspend' ? SUSPENDABLE : RECYCLABLE;
  if (!allowed.includes(status)) {
    throw new HttpError(400, `实例当前状态 ${status} 不支持「${action}」，请先刷新确认`);
  }
};

const ACTION_LABEL: Readonly<Record<ActionKind, string>> = {
  suspend: '挂起',
  recycle: '回收（销毁 VM）',
  rebuild: '重建（销毁后重新克隆）',
  probe: '探活',
};

export const desktopAdminRoutes: FastifyPluginAsync = async (app) => {
  /* ---------------- 实例列表 ---------------- */

  app.get<{ Querystring: z.infer<typeof instanceQuerySchema> }>('/admin/desktops', {
    schema: asRouteSchema({
      querystring: instanceQuerySchema,
      response: { 200: z.array(desktopAdminOutSchema) },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const {
      skip, limit, status, user_id: userId, desktop_mode: desktopMode,
    } = request.query;

    return app.withDb(async (db) => {
      const filters = [
        status ? eq(deskInstances.status, status as DeskInstanceStatus) : undefined,
        userId === undefined ? undefined : eq(deskInstances.userId, userId),
        desktopMode === undefined ? undefined : eq(users.desktopMode, desktopMode),
      ].filter((clause): clause is NonNullable<typeof clause> => clause !== undefined);

      const rows = await db.db.select({
        instance: deskInstances,
        user: users,
        vm: desktopVms,
        template: desktopTemplates,
        quota: desktopQuotas,
      }).from(deskInstances)
        .innerJoin(users, eq(users.id, deskInstances.userId))
        .leftJoin(desktopVms, eq(desktopVms.id, deskInstances.currentVmId))
        .leftJoin(desktopTemplates, eq(desktopTemplates.id, deskInstances.templateId))
        .leftJoin(desktopQuotas, eq(desktopQuotas.id, deskInstances.quotaId))
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(deskInstances.updatedAt))
        .offset(skip)
        .limit(limit);

      // 批量取每个实例的「最近一条任务」：一次 IN 查询再在内存里折叠，
      // 而不是给每行写相关子查询 —— 列表页最多 200 行，避免 N+1 拖死管理页。
      const latest = new Map<number, DesktopTask>();
      if (rows.length > 0) {
        const tasks = await db.db.select().from(desktopTasks)
          .where(inArray(desktopTasks.instanceId, rows.map((row) => row.instance.id)))
          .orderBy(desc(desktopTasks.id));
        // 按 id 倒序扫一遍，第一次见到的就是该实例最新的
        for (const task of tasks) {
          if (task.instanceId !== null && !latest.has(task.instanceId)) {
            latest.set(task.instanceId, task);
          }
        }
      }

      return rows.map((row) => toDesktopAdminOut({
        instance: row.instance,
        username: row.user.username,
        desktopMode: row.user.desktopMode,
        desktopEnabled: row.user.desktopEnabled,
        vm: row.vm ?? null,
        templateCode: row.template?.code ?? null,
        templateUpdatedAt: row.template?.updatedAt ?? null,
        quotaCode: row.quota?.code ?? null,
      }, latest.get(row.instance.id) ?? null));
    });
  });

  /* ---------------- 任务队列 ---------------- */

  app.get<{ Querystring: z.infer<typeof taskQuerySchema> }>('/admin/desktop-tasks', {
    schema: asRouteSchema({
      querystring: taskQuerySchema,
      response: { 200: z.array(desktopTaskOutSchema) },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const {
      skip, limit, status, type, instance_id: instanceId,
    } = request.query;

    return app.withDb(async (db) => {
      const filters = [
        status ? eq(desktopTasks.status, status as DesktopTask['status']) : undefined,
        type ? eq(desktopTasks.type, type as DesktopTask['type']) : undefined,
        instanceId === undefined ? undefined : eq(desktopTasks.instanceId, instanceId),
      ].filter((clause): clause is NonNullable<typeof clause> => clause !== undefined);

      const rows = await db.db.select().from(desktopTasks)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(desktopTasks.id))
        .offset(skip)
        .limit(limit);

      return rows.map(toDesktopTaskOut);
    });
  });

  /* ---------------- 实例动作（挂起 / 回收 / 探活） ---------------- */

  const handleAction = async (
    request: FastifyRequest<{ Params: z.infer<typeof instanceParamsSchema> }>,
    action: ActionKind,
  ): Promise<z.infer<typeof desktopActionOutSchema>> => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { instance_id: instanceId } = request.params;

    const instance = await app.withDb(async (db) => {
      const [row] = await db.db.select().from(deskInstances)
        .where(eq(deskInstances.id, instanceId)).limit(1);
      return row ?? null;
    });
    if (instance === null) throw new HttpError(404, '桌面实例不存在');

    assertInstanceStatus(instance.status, action);

    // 重建是唯一「先销毁再克隆」的动作：配置层能拦的就在这里拦掉，
    // 免得运维看到「已受理」之后再等一条注定失败的任务。
    if (action === 'rebuild' && instance.quotaId !== null) {
      const { quotaId } = instance;
      const allowRebuild = await app.withDb(async (db) => {
        const [row] = await db.db.select({ allowRebuild: desktopQuotas.allowRebuild })
          .from(desktopQuotas).where(eq(desktopQuotas.id, quotaId)).limit(1);
        return row?.allowRebuild ?? true;
      });
      if (!allowRebuild) {
        throw new HttpError(422, '该用户所属配额已禁止重建（allow_rebuild=false）');
      }
    }

    // 探活复用 worker 自己的幂等键格式（probe:instance:<id>:<minute>），
    // 与自动探测天然去重：同一分钟内点两次只会有一个 probe 任务。
    const taskKey = action === 'probe'
      ? `probe:instance:${instanceId}:${minuteKey()}`
      : `admin:${action}:instance:${instanceId}:${minuteKey()}`;

    const outcome = await enqueueTask({
      taskKey,
      type: action,
      instanceId,
      userId: instance.userId,
    });

    await app.withDb(async (db) => {
      await recordAudit(db, {
        userId: admin.id,
        action: `desktop_admin_${action}`,
        detail: `管理员 ${admin.username} ${ACTION_LABEL[action]}桌面 instance_id=${instanceId}`
          + `（状态 ${instance.status}，task=${outcome.created ? outcome.id : '幂等命中'}）`,
        ipAddr: clientIp,
      });
      await db.commit();
    });

    return {
      message: outcome.created
        ? `已受理${ACTION_LABEL[action]}，稍后刷新状态`
        : `${ACTION_LABEL[action]}任务已在本分钟内排队，未重复提交`,
      task_id: outcome.created ? outcome.id : null,
      created: outcome.created,
    };
  };

  app.post<{ Params: z.infer<typeof instanceParamsSchema> }>('/admin/desktops/:instance_id/suspend', {
    schema: asRouteSchema({
      params: instanceParamsSchema,
      response: { 200: desktopActionOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => handleAction(request, 'suspend'));

  app.post<{ Params: z.infer<typeof instanceParamsSchema> }>('/admin/desktops/:instance_id/recycle', {
    schema: asRouteSchema({
      params: instanceParamsSchema,
      response: { 200: desktopActionOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => handleAction(request, 'recycle'));

  app.post<{ Params: z.infer<typeof instanceParamsSchema> }>('/admin/desktops/:instance_id/rebuild', {
    schema: asRouteSchema({
      params: instanceParamsSchema,
      response: { 200: desktopActionOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => handleAction(request, 'rebuild'));

  app.post<{ Params: z.infer<typeof instanceParamsSchema> }>('/admin/desktops/:instance_id/probe', {
    schema: asRouteSchema({
      params: instanceParamsSchema,
      response: { 200: desktopActionOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => handleAction(request, 'probe'));

  /* ---------------- 重跑失败任务 ---------------- */

  app.post<{ Params: z.infer<typeof taskParamsSchema> }>('/admin/desktop-tasks/:task_id/retry', {
    schema: asRouteSchema({
      params: taskParamsSchema,
      response: { 200: desktopTaskOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { task_id: taskId } = request.params;

    return app.withDb(async (db) => {
      const [task] = await db.db.select().from(desktopTasks)
        .where(eq(desktopTasks.id, taskId)).for('update').limit(1);
      if (task === undefined) throw new HttpError(404, '任务不存在');

      // 只允许重跑 failed：pending/running 的任务重跑会与 worker 抢同一条记录
      if (task.status !== 'failed') {
        throw new HttpError(400, `只有 failed 的任务可以重跑（当前 ${task.status}）`);
      }

      // attempts 归零：运维已确认要再试一轮，不该被历史尝试次数立刻打到 failed
      const [updated] = await db.db.update(desktopTasks).set({
        status: 'pending',
        stage: null,
        progress: 0,
        attempts: 0,
        notBefore: new Date(),
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
      }).where(eq(desktopTasks.id, taskId)).returning();

      await recordAudit(db, {
        userId: admin.id,
        action: 'desktop_task_retry',
        detail: `管理员 ${admin.username} 重跑任务 id=${taskId} type=${task.type}`
          + `（原错误 ${task.errorCode ?? '-'}: ${(task.errorMessage ?? '').slice(0, 200)}）`,
        ipAddr: clientIp,
      });
      await db.commit();

      return toDesktopTaskOut(updated ?? task);
    });
  });

  /* ---------------- 模板（只读） ---------------- */

  app.get('/admin/desktop-templates', {
    schema: asRouteSchema({ response: { 200: z.array(desktopTemplateOutSchema) } }),
    preHandler: [authenticate, requireAdmin],
  }, async () => app.withDb(async (db) => {
    const rows = await db.db.select().from(desktopTemplates).orderBy(asc(desktopTemplates.id));
    return rows.map(toDesktopTemplateOut);
  }));

  /* ---------------- 配额（规格分档的唯一入口） ---------------- */

  app.get('/admin/desktop-quotas', {
    schema: asRouteSchema({ response: { 200: z.array(desktopQuotaOutSchema) } }),
    preHandler: [authenticate, requireAdmin],
  }, async () => app.withDb(async (db) => {
    const rows = await db.db.select().from(desktopQuotas).orderBy(asc(desktopQuotas.id));
    return rows.map(toDesktopQuotaOut);
  }));

  app.put<{
    Params: z.infer<typeof quotaParamsSchema>;
    Body: z.infer<typeof quotaUpdateSchema>;
  }>('/admin/desktop-quotas/:quota_id', {
    schema: asRouteSchema({
      params: quotaParamsSchema,
      body: quotaUpdateSchema,
      response: { 200: desktopQuotaOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { quota_id: quotaId } = request.params;
    const { body } = request;

    return app.withDb(async (db) => {
      const [quota] = await db.db.select().from(desktopQuotas)
        .where(eq(desktopQuotas.id, quotaId)).for('update').limit(1);
      if (quota === undefined) throw new HttpError(404, '配额不存在');

      // 先合并再校验：只改一个字段时，跨字段约束（default ≤ max）必须对**合并后**的值成立
      const next = {
        defaultVcpu: body.default_vcpu === undefined ? quota.defaultVcpu : body.default_vcpu,
        defaultMemoryMb: body.default_memory_mb === undefined
          ? quota.defaultMemoryMb : body.default_memory_mb,
        maxVcpu: body.max_vcpu ?? quota.maxVcpu,
        maxMemoryMb: body.max_memory_mb ?? quota.maxMemoryMb,
        maxDiskGb: body.max_disk_gb ?? quota.maxDiskGb,
        maxInstances: body.max_instances ?? quota.maxInstances,
        maxDailyHours: body.max_daily_hours === undefined
          ? quota.maxDailyHours : body.max_daily_hours,
        maxIdleDays: body.max_idle_days ?? quota.maxIdleDays,
        rebuildAfterDays: body.rebuild_after_days ?? quota.rebuildAfterDays,
        destroyAfterIdleDays: body.destroy_after_idle_days ?? quota.destroyAfterIdleDays,
        allowRebuild: body.allow_rebuild ?? quota.allowRebuild,
        templateId: body.template_id === undefined ? quota.templateId : body.template_id,
      };

      if (next.defaultVcpu !== null && next.defaultVcpu > next.maxVcpu) {
        throw new HttpError(422, `default_vcpu(${next.defaultVcpu}) 不能大于 max_vcpu(${next.maxVcpu})`);
      }
      if (next.defaultMemoryMb !== null && next.defaultMemoryMb > next.maxMemoryMb) {
        throw new HttpError(
          422,
          `default_memory_mb(${next.defaultMemoryMb}) 不能大于 max_memory_mb(${next.maxMemoryMb})`,
        );
      }
      // 销毁早于挂起等于「还没挂就先删了」，reaper 会按天数各算一遍，语义上必须有序
      if (next.destroyAfterIdleDays < next.maxIdleDays) {
        throw new HttpError(
          422,
          `destroy_after_idle_days(${next.destroyAfterIdleDays}) 不能小于 max_idle_days(${next.maxIdleDays})`,
        );
      }
      if (next.templateId !== null) {
        const [template] = await db.db.select({ id: desktopTemplates.id }).from(desktopTemplates)
          .where(eq(desktopTemplates.id, next.templateId)).limit(1);
        if (template === undefined) throw new HttpError(422, '绑定模板不存在');
      }

      const [updated] = await db.db.update(desktopQuotas).set({
        defaultVcpu: next.defaultVcpu,
        defaultMemoryMb: next.defaultMemoryMb,
        maxVcpu: next.maxVcpu,
        maxMemoryMb: next.maxMemoryMb,
        maxDiskGb: next.maxDiskGb,
        maxInstances: next.maxInstances,
        // numeric 列：drizzle 读写都是 string，写入时显式转
        maxDailyHours: next.maxDailyHours === null ? null : String(next.maxDailyHours),
        maxIdleDays: next.maxIdleDays,
        rebuildAfterDays: next.rebuildAfterDays,
        destroyAfterIdleDays: next.destroyAfterIdleDays,
        allowRebuild: next.allowRebuild,
        templateId: next.templateId,
        updatedAt: new Date(),
      }).where(eq(desktopQuotas.id, quotaId)).returning();

      await recordAudit(db, {
        userId: admin.id,
        action: 'desktop_quota_update',
        detail: `管理员 ${admin.username} 更新配额 ${quota.code}: `
          + `spec=${next.defaultVcpu ?? '模板'}/${next.defaultMemoryMb ?? '模板'} `
          + `max=${next.maxVcpu}c/${next.maxMemoryMb}MB, 空闲 ${next.maxIdleDays}d 挂起 / `
          + `${next.destroyAfterIdleDays}d 销毁`,
        ipAddr: clientIp,
      });
      await db.commit();

      return toDesktopQuotaOut(updated ?? quota);
    });
  });

  /* ---------------- 模板登记（provider_ref 的语义随 provider 变） ---------------- */

  app.post<{ Body: z.infer<typeof templateUpsertSchema> }>('/admin/desktop-templates', {
    schema: asRouteSchema({
      body: templateUpsertSchema,
      response: { 200: desktopTemplateOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { body } = request;
    const providerKind = getSettings().desktopProvider;

    // 只允许登记「当前 provider」的模板：混着登记会让 pickTemplate 在建实例时才报错，
    // 而这个错误要到 worker 日志里才能看见。
    if (body.provider !== providerKind) {
      throw new HttpError(
        422,
        `模板 provider='${body.provider}' 与当前 DESKTOP_PROVIDER='${providerKind}' 不一致；`
        + `切换 provider 请先改 .env 并重启，再登记对应模板`,
      );
    }
    // provider_ref 格式轻校验：写错只会在创建时炸，且报错完全指不到病根
    if (body.provider === 'ecs' && !/^[mami]-/.test(body.provider_ref)) {
      throw new HttpError(422, "ECS 模板的 provider_ref 应是自定义镜像 ID（形如 'm-xxxx' 或 'ami-xxxx'）");
    }
    if (body.provider === 'proxmox' && !/^(\d+|[^/]+\/\d+)$/.test(body.provider_ref)) {
      throw new HttpError(422, "Proxmox 模板的 provider_ref 应是 '<node>/<vmid>' 或纯 vmid（如 'pve1/9001'）");
    }
    if (body.is_default && body.status !== 'active') {
      throw new HttpError(422, '只有 active 模板才能设为默认');
    }

    return app.withDb(async (db) => {
      // ⚠️ 顺序不能反：`uq_desktop_templates_default` 是「is_default=true 唯一」的
      // 部分索引，先 upsert 新默认再取消旧默认会立刻撞索引（500）。
      // 必须先让出默认位，再写入新的默认。
      if (body.is_default) {
        await db.db.update(desktopTemplates)
          .set({ isDefault: false })
          .where(and(
            eq(desktopTemplates.isDefault, true),
            sql`${desktopTemplates.code} <> ${body.code}`,
          ));
      }

      const [saved] = await db.db.insert(desktopTemplates).values({
        code: body.code,
        name: body.name,
        osType: body.os_type,
        osVersion: body.os_version ?? null,
        provider: body.provider,
        providerRef: body.provider_ref,
        providerNode: body.provider_node ?? null,
        vcpu: body.vcpu,
        memoryMb: body.memory_mb,
        diskGb: body.disk_gb,
        storage: body.storage ?? null,
        guestUsername: body.guest_username ?? null,
        status: body.status,
        isDefault: body.is_default,
        maxInstances: body.max_instances ?? null,
      }).onConflictDoUpdate({
        target: desktopTemplates.code,
        // 同一 code 视为「更新登记」：镜像重建（新 image id）后直接覆盖，不必先删
        set: {
          name: body.name,
          osType: body.os_type,
          osVersion: body.os_version ?? null,
          provider: body.provider,
          providerRef: body.provider_ref,
          providerNode: body.provider_node ?? null,
          vcpu: body.vcpu,
          memoryMb: body.memory_mb,
          diskGb: body.disk_gb,
          storage: body.storage ?? null,
          guestUsername: body.guest_username ?? null,
          status: body.status,
          isDefault: body.is_default,
          maxInstances: body.max_instances ?? null,
          updatedAt: new Date(),
        },
      }).returning();

      // 默认模板全局唯一（上面的预清理已保证不会撞部分唯一索引）
      await recordAudit(db, {
        userId: admin.id,
        action: 'desktop_template_upsert',
        detail: `管理员 ${admin.username} 登记模板 ${body.code}（${body.provider}）`
          + ` ref=${body.provider_ref} spec=${body.vcpu}c/${body.memory_mb}MB`
          + `${body.is_default ? ' 设为默认' : ''}`,
        ipAddr: clientIp,
      });
      await db.commit();

      return toDesktopTemplateOut(saved!);
    });
  });
};
