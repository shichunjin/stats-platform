/**
 * 管理端云桌面接口 —— docs/multi-vm-desktop-plan.md 6.6 / 7.6 / 7.8
 *
 * 锁四条承诺：
 *  1. **权限**：只有 admin 能访问（普通用户 403、未认证 401）
 *  2. **只看灰度不影响运维**：开关关掉后这些接口照常可用（否则关开关就留孤儿 VM）
 *  3. **动作入队而非同步执行**：返回 task_id，执行交给 worker；同分钟重复点击被幂等
 *  4. **配额跨字段约束**：default_* ≤ max_*、销毁天数 ≥ 挂起天数，一律 422 拒绝
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  afterAll, afterEach, beforeEach, describe, expect, it,
} from 'vitest';
import { resetSettings } from '../../src/config/env.js';
import {
  deskInstances, desktopQuotas, desktopTasks, desktopTemplates, desktopVms,
  type DeskInstanceStatus, type DesktopTaskStatus, type DesktopTaskType,
} from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { findAudit, buildTestApp, request, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

let app: FastifyInstance;

const insertTemplate = async (): Promise<number> => withSession(async (db) => {
  const [row] = await db.db.insert(desktopTemplates).values({
    code: 'win2022-stats-v1',
    name: '统计软件桌面 v1',
    provider: 'proxmox',
    providerRef: 'pve1/9001',
    providerNode: 'pve1',
    vcpu: 4,
    memoryMb: 8192,
    diskGb: 120,
    storage: 'local-lvm',
    loginScriptVer: 'abc123def456',
    isDefault: true,
  }).returning();
  await db.commit();
  return row!.id;
});

const insertQuota = async (
  templateId: number | null,
  overrides: { readonly allowRebuild?: boolean } = {},
): Promise<number> =>
  withSession(async (db) => {
    const [row] = await db.db.insert(desktopQuotas).values({
      code: 'default',
      name: '默认档',
      defaultVcpu: 2,
      defaultMemoryMb: 4096,
      maxVcpu: 4,
      maxMemoryMb: 8192,
      maxIdleDays: 7,
      destroyAfterIdleDays: 30,
      allowRebuild: overrides.allowRebuild ?? true,
      templateId,
    }).returning();
    await db.commit();
    return row!.id;
  });

interface SeedInstanceOptions {
  readonly username: string;
  readonly status?: DeskInstanceStatus;
  readonly templateId: number;
  readonly quotaId?: number | null;
  readonly powerState?: 'running' | 'stopped' | 'suspended' | 'unknown';
  /** 是否挂一台当前 VM（null = 已解绑/还在克隆） */
  readonly withVm?: boolean;
}

const seedInstance = async (options: SeedInstanceOptions): Promise<number> => {
  const user = await seedUser({ username: options.username });
  return withSession(async (db) => {
    const [instance] = await db.db.insert(deskInstances).values({
      userId: user.id,
      templateId: options.templateId,
      quotaId: options.quotaId ?? null,
      specVcpu: 2,
      specMemoryMb: 4096,
      status: options.status ?? 'ready',
    }).returning();

    if (options.withVm !== false) {
      const [vm] = await db.db.insert(desktopVms).values({
        instanceId: instance!.id,
        templateId: options.templateId,
        provider: 'proxmox',
        providerRef: 'pve1/9101',
        providerNode: 'pve1',
        name: `DESK-${options.username}`,
        primaryIp: '10.20.3.11',
        powerState: options.powerState ?? 'running',
      }).returning();
      await db.db.update(deskInstances).set({ currentVmId: vm!.id })
        .where(eq(deskInstances.id, instance!.id));
    }

    await db.commit();
    return instance!.id;
  });
};

const seedTask = async (options: {
  readonly taskKey: string;
  readonly type: DesktopTaskType;
  readonly status: DesktopTaskStatus;
  readonly instanceId?: number | null;
  readonly attempts?: number;
  readonly errorMessage?: string;
}): Promise<number> => withSession(async (db) => {
  const [row] = await db.db.insert(desktopTasks).values({
    taskKey: options.taskKey,
    type: options.type,
    status: options.status,
    instanceId: options.instanceId ?? null,
    attempts: options.attempts ?? 0,
    errorMessage: options.errorMessage ?? null,
  }).returning();
  await db.commit();
  return row!.id;
});

beforeEach(async () => {
  await resetDatabase();
  app = await buildTestApp();
});

afterEach(() => {
  resetSettings();
});

afterAll(async () => {
  await app.close();
});

describe('权限', () => {
  it('普通用户访问管理端 → 403', async () => {
    const alice = await seedUser({ username: 'alice' });
    const response = await request(app, { method: 'GET', url: '/admin/desktops', user: alice });
    expect(response.statusCode).toBe(403);
  });

  it('未认证 → 401', async () => {
    const response = await request(app, { method: 'GET', url: '/admin/desktops', user: null });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /admin/desktops', () => {
  it('一行给全 user/vm/模板/配额/最近任务', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId);
    const instanceId = await seedInstance({
      username: 'alice', templateId, quotaId, status: 'ready',
    });
    await seedTask({
      taskKey: 'create:instance:1', type: 'create', status: 'success', instanceId,
    });
    await seedTask({
      taskKey: 'probe:instance:1:1', type: 'probe', status: 'failed',
      instanceId, errorMessage: '3389 不可达',
    });

    const response = await request(app, { method: 'GET', url: '/admin/desktops', user: admin });
    expect(response.statusCode).toBe(200);

    const rows = response.json<Array<Record<string, unknown>>>();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.username).toBe('alice');
    expect(row.status).toBe('ready');
    expect(row.spec_vcpu).toBe(2);
    expect(row.vm_ip).toBe('10.20.3.11');
    expect(row.provider_ref).toBe('pve1/9101');
    expect(row.power_state).toBe('running');
    expect(row.template_code).toBe('win2022-stats-v1');
    expect(row.quota_code).toBe('default');
    // 最近任务取 id 最大的那条（probe 失败），而不是 create
    expect(row.task_type).toBe('probe');
    expect(row.task_status).toBe('failed');
    expect(row.task_error).toBe('3389 不可达');
    // 模板刚建、VM 后建 → 没有漂移
    expect(row.template_drift).toBe(false);
    expect(typeof row.vm_created_at).toBe('string');
    expect(typeof row.created_at).toBe('string');
  });

  it('模板在 VM 创建后被更新 → template_drift=true（这台机器可能还在跑旧脚本）', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    await seedInstance({ username: 'alice', templateId, status: 'ready' });

    // 直接把模板 updatedAt 推到未来，模拟「先建 VM、后改模板」
    await withSession(async (db) => {
      await db.db.update(desktopTemplates)
        .set({ updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(desktopTemplates.id, templateId));
      await db.commit();
    });

    const response = await request(app, { method: 'GET', url: '/admin/desktops', user: admin });
    expect(response.json<Array<Record<string, unknown>>>()[0]!.template_drift).toBe(true);
  });

  it('支持按 status 与 desktop_mode 过滤', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    await seedInstance({ username: 'alice', templateId, status: 'ready' });
    await seedInstance({ username: 'bob', templateId, status: 'destroyed', withVm: false });

    const ready = await request(app, {
      method: 'GET', url: '/admin/desktops?status=ready', user: admin,
    });
    expect(ready.json<Array<{ username: string }>>().map((r) => r.username)).toEqual(['alice']);

    // 两个用户默认都是 rds 模式 → 过滤 vm 应为空
    const vmOnly = await request(app, {
      method: 'GET', url: '/admin/desktops?desktop_mode=vm', user: admin,
    });
    expect(vmOnly.json<unknown[]>()).toHaveLength(0);
  });
});

describe('GET /admin/desktop-tasks', () => {
  it('按 type + status 过滤，并输出重试时间', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    await seedTask({ taskKey: 'create:instance:1', type: 'create', status: 'success' });
    await seedTask({
      taskKey: 'probe:instance:1:1', type: 'probe', status: 'failed', errorMessage: '超时',
    });

    const response = await request(app, {
      method: 'GET', url: '/admin/desktop-tasks?type=probe&status=failed', user: admin,
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json<Array<Record<string, unknown>>>();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_key).toBe('probe:instance:1:1');
    expect(rows[0]!.max_attempts).toBe(3);
    expect(typeof rows[0]!.not_before).toBe('string');
  });
});

describe('POST /admin/desktops/:id/{suspend,recycle,probe}', () => {
  it('挂起 ready 实例 → 入队 + 审计；同分钟重复点击幂等', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    const instanceId = await seedInstance({ username: 'alice', templateId, status: 'ready' });

    const first = await request(app, {
      method: 'POST', url: `/admin/desktops/${instanceId}/suspend`, user: admin,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{ created: boolean; task_id: number | null }>();
    expect(firstBody.created).toBe(true);
    expect(firstBody.task_id).toBeGreaterThan(0);

    const tasks = await withSession(async (db) => db.db.select().from(desktopTasks));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.type).toBe('suspend');
    expect(tasks[0]!.status).toBe('pending');

    const audit = await findAudit('desktop_admin_suspend');
    expect(audit?.userId).toBe(admin.id);

    const second = await request(app, {
      method: 'POST', url: `/admin/desktops/${instanceId}/suspend`, user: admin,
    });
    const secondBody = second.json<{ created: boolean; task_id: number | null }>();
    expect(secondBody.created).toBe(false);
    expect(secondBody.task_id).toBeNull();
    expect(await withSession(async (db) => db.db.select().from(desktopTasks))).toHaveLength(1);
  });

  it('destroyed 实例不可挂起 → 400', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    const instanceId = await seedInstance({
      username: 'alice', templateId, status: 'destroyed', withVm: false,
    });

    const response = await request(app, {
      method: 'POST', url: `/admin/desktops/${instanceId}/suspend`, user: admin,
    });
    expect(response.statusCode).toBe(400);
    expect(await withSession(async (db) => db.db.select().from(desktopTasks))).toHaveLength(0);
  });

  it('卡在 provisioning 的僵尸也能回收（不要求先就绪）', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    const instanceId = await seedInstance({
      username: 'alice', templateId, status: 'provisioning', withVm: false,
    });

    const response = await request(app, {
      method: 'POST', url: `/admin/desktops/${instanceId}/recycle`, user: admin,
    });
    expect(response.statusCode).toBe(200);

    const tasks = await withSession(async (db) => db.db.select().from(desktopTasks));
    expect(tasks[0]!.type).toBe('recycle');
  });

  it('探活复用自动探测的幂等键格式（同一分钟只排一个）', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    const instanceId = await seedInstance({ username: 'alice', templateId });

    const response = await request(app, {
      method: 'POST', url: `/admin/desktops/${instanceId}/probe`, user: admin,
    });
    expect(response.statusCode).toBe(200);

    const tasks = await withSession(async (db) => db.db.select().from(desktopTasks));
    expect(tasks[0]!.taskKey).toMatch(/^probe:instance:\d+:\d+$/);
  });

  it('实例不存在 → 404', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const response = await request(app, {
      method: 'POST', url: '/admin/desktops/9999/recycle', user: admin,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /admin/desktops/:id/rebuild', () => {
  it('配额允许 → 入队 rebuild 任务并返回 task_id', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId, { allowRebuild: true });
    const instanceId = await seedInstance({
      username: 'alice', templateId, quotaId, status: 'ready',
    });

    const response = await request(app, {
      method: 'POST', url: `/admin/desktops/${instanceId}/rebuild`, user: admin,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ created: boolean; task_id: number | null }>();
    expect(body.created).toBe(true);
    expect(body.task_id).not.toBeNull();

    const tasks = await withSession(async (db) => db.db.select().from(desktopTasks));
    expect(tasks[0]!.type).toBe('rebuild');
    expect(tasks[0]!.instanceId).toBe(instanceId);
  });

  it('配额 allow_rebuild=false → 422 且不入队（别让人等一条注定失败的任务）', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId, { allowRebuild: false });
    const instanceId = await seedInstance({
      username: 'alice', templateId, quotaId, status: 'ready',
    });

    const response = await request(app, {
      method: 'POST', url: `/admin/desktops/${instanceId}/rebuild`, user: admin,
    });
    expect(response.statusCode).toBe(422);
    const tasks = await withSession(async (db) => db.db.select().from(desktopTasks));
    expect(tasks).toHaveLength(0);
  });

  it('终态实例（destroyed）→ 400，先让用户重新申请', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const templateId = await insertTemplate();
    const instanceId = await seedInstance({
      username: 'alice', templateId, status: 'destroyed', withVm: false,
    });

    const response = await request(app, {
      method: 'POST', url: `/admin/desktops/${instanceId}/rebuild`, user: admin,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('POST /admin/desktop-tasks/:id/retry', () => {
  it('failed → pending，attempts 归零、错误清空', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const taskId = await seedTask({
      taskKey: 'create:instance:1', type: 'create', status: 'failed',
      attempts: 3, errorMessage: 'PVE 500',
    });

    const response = await request(app, {
      method: 'POST', url: `/admin/desktop-tasks/${taskId}/retry`, user: admin,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<Record<string, unknown>>();
    expect(body.status).toBe('pending');
    expect(body.attempts).toBe(0);
    expect(body.error_message).toBeNull();
    expect(body.stage).toBeNull();

    const [row] = await withSession(async (db) => db.db.select().from(desktopTasks)
      .where(eq(desktopTasks.id, taskId)));
    expect(row!.status).toBe('pending');
    expect((await findAudit('desktop_task_retry'))?.userId).toBe(admin.id);
  });

  it('pending 任务不可重跑（会与 worker 抢记录）→ 400', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const taskId = await seedTask({
      taskKey: 'create:instance:1', type: 'create', status: 'pending',
    });

    const response = await request(app, {
      method: 'POST', url: `/admin/desktop-tasks/${taskId}/retry`, user: admin,
    });
    expect(response.statusCode).toBe(400);
  });

  it('任务不存在 → 404', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const response = await request(app, {
      method: 'POST', url: '/admin/desktop-tasks/9999/retry', user: admin,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('模板与配额', () => {
  it('模板列表带 login_script_ver（用于与模板清单核对）', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    await insertTemplate();

    const response = await request(app, {
      method: 'GET', url: '/admin/desktop-templates', user: admin,
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json<Array<Record<string, unknown>>>();
    expect(rows[0]!.code).toBe('win2022-stats-v1');
    expect(rows[0]!.login_script_ver).toBe('abc123def456');
    expect(rows[0]!.is_default).toBe(true);
  });

  it('配额列表把 numeric(max_daily_hours) 收敛成数字（不 500）', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const quotaId = await insertQuota(null);
    await withSession(async (db) => {
      await db.db.update(desktopQuotas).set({ maxDailyHours: '7.50' })
        .where(eq(desktopQuotas.id, quotaId));
      await db.commit();
    });

    const response = await request(app, {
      method: 'GET', url: '/admin/desktop-quotas', user: admin,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<Array<Record<string, unknown>>>()[0]!.max_daily_hours).toBe(7.5);
  });

  it('default_vcpu 超过 max_vcpu → 422 且不落库', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const quotaId = await insertQuota(null);

    const response = await request(app, {
      method: 'PUT',
      url: `/admin/desktop-quotas/${quotaId}`,
      user: admin,
      payload: { default_vcpu: 8 },
    });
    expect(response.statusCode).toBe(422);

    const [row] = await withSession(async (db) => db.db.select().from(desktopQuotas)
      .where(eq(desktopQuotas.id, quotaId)));
    expect(row!.defaultVcpu).toBe(2);
  });

  it('销毁天数小于挂起天数 → 422（否则 reaper 语义自相矛盾）', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const quotaId = await insertQuota(null);

    const response = await request(app, {
      method: 'PUT',
      url: `/admin/desktop-quotas/${quotaId}`,
      user: admin,
      payload: { max_idle_days: 10, destroy_after_idle_days: 5 },
    });
    expect(response.statusCode).toBe(422);
  });

  it('成功更新：default_* 置 null 表示「取模板基线」', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const quotaId = await insertQuota(null);

    const response = await request(app, {
      method: 'PUT',
      url: `/admin/desktop-quotas/${quotaId}`,
      user: admin,
      payload: { default_vcpu: null, default_memory_mb: null, max_daily_hours: 6 },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<Record<string, unknown>>();
    expect(body.default_vcpu).toBeNull();
    expect(body.default_memory_mb).toBeNull();
    expect(body.max_daily_hours).toBe(6);
    expect((await findAudit('desktop_quota_update'))?.userId).toBe(admin.id);
  });

  it('绑定不存在的模板 → 422', async () => {
    const admin = await seedUser({ username: 'root', role: 'admin' });
    const quotaId = await insertQuota(null);

    const response = await request(app, {
      method: 'PUT',
      url: `/admin/desktop-quotas/${quotaId}`,
      user: admin,
      payload: { template_id: 9999 },
    });
    expect(response.statusCode).toBe(422);
  });
});
