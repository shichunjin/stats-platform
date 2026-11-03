/**
 * 云桌面 API 与 create 流水线 —— docs/multi-vm-desktop-plan.md 6.4 / 6.6
 *
 * 锁三条对外承诺：
 *  1. **灰度**：开关关闭时一律 mode=rds（前端继续走老 /session/connect），不报错
 *  2. **幂等**：重复 ensure 不建第二个实例、不重复入队
 *  3. **终态语义**：VM 建好后是 awaiting_account 而不是 ready ——
 *     VM 里还没有 Windows 账号（平台拿不到明文密码），此时 RDP 连得上但登不进去
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideSettings, resetSettings } from '../../src/config/env.js';
import { deskInstances, desktopTasks, desktopTemplates, desktopVms, users, type User } from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { resetDesktopProvider, setDesktopProvider } from '../../src/desktop/provider/proxmox.js';
import type { DesktopProvider } from '../../src/desktop/provider/types.js';
import { runDueTasks } from '../../src/desktop/worker.js';
import { createCreateHandler } from '../../src/desktop/tasks/create.js';
import { buildTestApp, request, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

let app: FastifyInstance;

const insertTemplate = () => withSession(async (db) => {
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
    isDefault: true,
  }).returning();
  await db.commit();
  return row!;
});

const setVmMode = async (username: string): Promise<void> => {
  await withSession(async (db) => {
    await db.db.update(users).set({ desktopMode: 'vm' }).where(eq(users.username, username));
    await db.commit();
  });
};

const countInstances = async (): Promise<number> => withSession(async (db) => {
  const rows = await db.db.select({ id: deskInstances.id }).from(deskInstances);
  return rows.length;
});

beforeEach(async () => {
  await resetDatabase();
  app = await buildTestApp();
});

afterEach(() => {
  resetSettings();
  resetDesktopProvider();
});

afterAll(async () => {
  await app.close();
});

describe('POST /desktop/ensure（灰度与幂等）', () => {
  it('全局开关关闭 → mode=rds（不报错，前端走老路径）', async () => {
    const alice = await seedUser({ username: 'alice' });
    await setVmMode('alice');

    const response = await request(app, { method: 'POST', url: '/desktop/ensure', user: alice });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: 'rds', instance_id: null, status: null, ready: false,
      created: false, task_id: null, vm_ip: null,
    });
    expect(await countInstances()).toBe(0);
  });

  it('用户仍是 rds 模式 → 不建实例（即使全局已开）', async () => {
    overrideSettings({ desktopEnabled: true });
    const alice = await seedUser({ username: 'alice' });

    const response = await request(app, { method: 'POST', url: '/desktop/ensure', user: alice });
    expect(response.json<{ mode: string }>().mode).toBe('rds');
  });

  it('vm 模式：首调用建实例并入队；重复调用命中幂等', async () => {
    overrideSettings({ desktopEnabled: true });
    await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    await setVmMode('alice');

    const first = await request(app, { method: 'POST', url: '/desktop/ensure', user: alice });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      mode: string; instance_id: number; created: boolean; task_id: number; status: string;
    }>();
    expect(firstBody.mode).toBe('vm');
    expect(firstBody.created).toBe(true);
    expect(firstBody.status).toBe('new');
    expect(firstBody.task_id).toBeGreaterThan(0);

    const second = await request(app, { method: 'POST', url: '/desktop/ensure', user: alice });
    const secondBody = second.json<{ created: boolean; instance_id: number }>();
    expect(secondBody.created).toBe(false);
    expect(secondBody.instance_id).toBe(firstBody.instance_id);

    expect(await countInstances()).toBe(1);
    const tasks = await withSession(async (db) => db.db.select().from(desktopTasks));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('pending');
  });

  it('未认证拒绝访问', async () => {
    const response = await request(app, { method: 'POST', url: '/desktop/ensure', user: null });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /desktop/status（只读，不触发创建）', () => {
  it('没有实例时返回 mode=vm 但 instance_id 为 null', async () => {
    overrideSettings({ desktopEnabled: true });
    const alice = await seedUser({ username: 'alice' });
    await setVmMode('alice');

    const response = await request(app, { method: 'GET', url: '/desktop/status', user: alice });
    const body = response.json<{ mode: string; instance_id: number | null }>();
    expect(body.mode).toBe('vm');
    expect(body.instance_id).toBeNull();
    expect(await countInstances()).toBe(0);
  });
});

describe('create 流水线', () => {
  const fakeProvider: DesktopProvider = {
    kind: 'proxmox',
    validateTemplate: async () => true,
    clone: async () => 'pve1/9101',
    start: async () => undefined,
    power: async () => undefined,
    shutdown: async () => undefined,
    destroy: async () => undefined,
    inspect: async () => ({ powerState: 'running', primaryIp: '10.20.3.11', agentReady: true }),
    snapshot: async (ref, name) => name,
    capacity: async () => ({ cpuUsage: 0.1, memUsage: 0.2, diskUsage: 0.3, freeIpCount: 5 }),
  };

  it('克隆 → 开机 → 回读状态 → 置 awaiting_account', async () => {
    overrideSettings({ desktopEnabled: true });
    setDesktopProvider(fakeProvider);

    const template = await insertTemplate();
    const alice: User = await seedUser({ username: 'alice' });
    await setVmMode('alice');

    const ensure = await request(app, { method: 'POST', url: '/desktop/ensure', user: alice });
    const instanceId = ensure.json<{ instance_id: number }>().instance_id;

    const summary = await runDueTasks({ handlers: { create: createCreateHandler() } });
    expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    const instance = await withSession(async (db) => {
      const [row] = await db.db.select().from(deskInstances)
        .where(eq(deskInstances.id, instanceId)).limit(1);
      return row!;
    });
    // 关键断言：不是 ready —— VM 里还没有 Windows 账号
    expect(instance.status).toBe('awaiting_account');
    expect(instance.currentVmId).not.toBeNull();

    const vms = await withSession(async (db) => db.db.select().from(desktopVms));
    expect(vms).toHaveLength(1);
    expect(vms[0]!.providerRef).toBe('pve1/9101');
    expect(vms[0]!.primaryIp).toBe('10.20.3.11');
    expect(vms[0]!.powerState).toBe('running');
    expect(vms[0]!.vcpu).toBe(template.vcpu);
  });

  /**
   * 真实场景：clone 成功落库后 start 失败 → 任务退避重试 → 重试时**不能**再克隆一台。
   * （漏了这条，一次网络抖动就会给用户留下两台 VM 和一台孤儿）
   */
  it('重试不重复克隆（已有 VM 就复用）', async () => {
    overrideSettings({ desktopEnabled: true, desktopRetryBackoffMs: 0 });
    let cloneCount = 0;
    let startCount = 0;
    setDesktopProvider({
      ...fakeProvider,
      clone: async () => { cloneCount += 1; return 'pve1/9102'; },
      start: async () => {
        startCount += 1;
        if (startCount === 1) throw new Error('PVE 网络抖动');
      },
    });

    await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    await setVmMode('alice');
    await request(app, { method: 'POST', url: '/desktop/ensure', user: alice });

    const first = await runDueTasks({ handlers: { create: createCreateHandler() } });
    expect(first.failed).toBe(1);
    expect(cloneCount).toBe(1);

    // 模拟退避到期：把任务放回队列（真实环境由 not_before 自然到期）
    await withSession(async (db) => {
      await db.db.update(desktopTasks)
        .set({ status: 'pending', notBefore: new Date(Date.now() - 1_000), attempts: 0 })
        .where(eq(desktopTasks.taskKey, 'create:instance:1'));
      await db.commit();
    });

    const second = await runDueTasks({ handlers: { create: createCreateHandler() } });
    expect(second.succeeded).toBe(1);
    expect(cloneCount).toBe(1);
    expect(startCount).toBe(2);

    const vms = await withSession(async (db) => db.db.select().from(desktopVms));
    expect(vms).toHaveLength(1);
    expect(vms[0]!.powerState).toBe('running');
  });

  it('Provider 未配置 → 任务失败且不建 VM（不会静默丢任务）', async () => {
    overrideSettings({ desktopEnabled: true });
    resetDesktopProvider();

    await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    await setVmMode('alice');
    await request(app, { method: 'POST', url: '/desktop/ensure', user: alice });

    const summary = await runDueTasks({ handlers: { create: createCreateHandler() } });
    expect(summary.failed).toBe(1);

    const vms = await withSession(async (db) => db.db.select().from(desktopVms));
    expect(vms).toHaveLength(0);
  });
});

/**
 * VM 模式下 `/session/connect` 的引导语义。
 *
 * 关键约定：连不上时**必须报错并给出可执行文案**，不能返回空 guac_url ——
 * 空 URL 在浏览器里是白屏，用户只会认为平台坏了。
 */
describe('POST /session/connect（VM 模式）', () => {
  const seedReadyInstance = async (instanceStatus: string, powerState: string) => {
    const templateId = (await insertTemplate()).id;
    const alice = await seedUser({ username: 'alice' });
    await setVmMode('alice');

    await withSession(async (db) => {
      const [instance] = await db.db.insert(deskInstances).values({
        userId: alice.id, templateId, status: instanceStatus as never,
        specVcpu: 4, specMemoryMb: 8192,
      }).returning();
      const [vm] = await db.db.insert(desktopVms).values({
        instanceId: instance!.id, templateId, provider: 'proxmox', providerRef: 'pve1/9101',
        name: 'DESK-alice', primaryIp: '10.20.3.11', powerState: powerState as never,
      }).returning();
      await db.db.update(deskInstances).set({ currentVmId: vm!.id })
        .where(eq(deskInstances.id, instance!.id));
      await db.commit();
      return instance!.id;
    });

    return { alice, templateId };
  };

  it('awaiting_account → 503 提示先改一次密码（不返回空 URL）', async () => {
    overrideSettings({ desktopEnabled: true });
    const { alice } = await seedReadyInstance('awaiting_account', 'running');

    const response = await request(app, { method: 'POST', url: '/session/connect', user: alice });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ detail?: string }>().detail ?? response.body).toContain('修改一次密码');
  });

  it('仍在克隆/开机 → 503「正在准备中」', async () => {
    overrideSettings({ desktopEnabled: true });
    const { alice } = await seedReadyInstance('provisioning', 'stopped');

    const response = await request(app, { method: 'POST', url: '/session/connect', user: alice });
    expect(response.statusCode).toBe(503);
  });

  it('已挂起 → 入队 start 唤醒并提示稍后重试', async () => {
    overrideSettings({ desktopEnabled: true });
    const { alice } = await seedReadyInstance('suspended', 'suspended');

    const response = await request(app, { method: 'POST', url: '/session/connect', user: alice });
    expect(response.statusCode).toBe(503);

    const tasks = await withSession(async (db) =>
      db.db.select().from(desktopTasks).where(eq(desktopTasks.type, 'start')));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('pending');
  });
});
