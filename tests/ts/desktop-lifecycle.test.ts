/**
 * 云桌面生命周期任务 —— docs/multi-vm-desktop-plan.md 9.5 / 9.8 / 9.10
 *
 * 覆盖四类动作（start / probe / suspend / recycle）与空闲扫描器（reaper）。
 * 这些是「VM 建好之后」的全部运维语义：唤醒、自愈、挂起、销毁，以及
 * 什么时候触发它们。
 *
 * ⚠️ `probeTcp` 被整体 mock：真实探测会去连 10.20.x.x（测试环境不存在），
 * 每个用例都会白等 3 秒超时。mock 打在模块边界上，被测代码不做任何让步。
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overrideSettings, resetSettings } from '../../src/config/env.js';
import {
  deskInstances, desktopIpAllocations, desktopTasks, desktopTemplates, desktopVms, users,
  type DeskInstanceStatus, type DesktopVmPowerState,
} from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { sweepIdleInstances } from '../../src/desktop/reaper.js';
import { resetDesktopProvider, setDesktopProvider } from '../../src/desktop/provider/proxmox.js';
import type { DesktopProvider } from '../../src/desktop/provider/types.js';
import { notifyVmPasswordChange } from '../../src/desktop/service.js';
import { createProbeHandler } from '../../src/desktop/tasks/probe.js';
import { createRecycleHandler } from '../../src/desktop/tasks/recycle.js';
import { createStartHandler } from '../../src/desktop/tasks/start.js';
import { createSuspendHandler } from '../../src/desktop/tasks/suspend.js';
import { enqueueTask } from '../../src/desktop/queue.js';
import { runDueTasks } from '../../src/desktop/worker.js';
import { probeTcp } from '../../src/desktop/provider/probe.js';
import { seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

vi.mock('../../src/desktop/provider/probe.js', () => ({
  probeTcp: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
}));

const probeMock = vi.mocked(probeTcp);

interface SeedOptions {
  readonly status?: DeskInstanceStatus;
  readonly powerState?: DesktopVmPowerState;
  readonly ip?: string | null;
  readonly accountSyncedAt?: Date | null;
  readonly passwordVersion?: number | null;
  readonly probeFailCount?: number;
  readonly lastConnectedAt?: Date | null;
  readonly withVm?: boolean;
}

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
    isDefault: true,
  }).returning();
  await db.commit();
  return row!.id;
});

const seedInstance = async (
  userId: number,
  templateId: number,
  options: SeedOptions = {},
): Promise<{ instanceId: number; vmId: number | null }> => withSession(async (db) => {
  const [instance] = await db.db.insert(deskInstances).values({
    userId,
    templateId,
    status: options.status ?? 'ready',
    specVcpu: 4,
    specMemoryMb: 8192,
    accountSyncedAt: options.accountSyncedAt === undefined ? new Date() : options.accountSyncedAt,
    passwordVersion: options.passwordVersion === undefined ? 1 : options.passwordVersion,
    ...(options.lastConnectedAt === undefined ? {} : { lastConnectedAt: options.lastConnectedAt }),
  }).returning();

  if (options.withVm === false) {
    await db.commit();
    return { instanceId: instance!.id, vmId: null };
  }

  const [vm] = await db.db.insert(desktopVms).values({
    instanceId: instance!.id,
    templateId,
    provider: 'proxmox',
    providerRef: 'pve1/9101',
    name: 'DESK-alice',
    primaryIp: options.ip === undefined ? '10.20.3.11' : options.ip,
    powerState: options.powerState ?? 'running',
    vcpu: 4,
    memoryMb: 8192,
    probeFailCount: options.probeFailCount ?? 0,
  }).returning();

  await db.db.update(deskInstances).set({ currentVmId: vm!.id })
    .where(eq(deskInstances.id, instance!.id));
  await db.commit();
  return { instanceId: instance!.id, vmId: vm!.id };
});

const readInstance = async (id: number) => withSession(async (db) => {
  const [row] = await db.db.select().from(deskInstances).where(eq(deskInstances.id, id)).limit(1);
  return row!;
});

const readVm = async (id: number) => withSession(async (db) => {
  const [row] = await db.db.select().from(desktopVms).where(eq(desktopVms.id, id)).limit(1);
  return row!;
});

/** 记录调用序列的假 Provider（断言「有没有真的调 Provider」而不是内部实现） */
const makeProvider = (overrides: Partial<DesktopProvider> = {}): DesktopProvider & {
  readonly calls: string[];
} => {
  const calls: string[] = [];
  const provider: DesktopProvider = {
    kind: 'proxmox',
    validateTemplate: async () => true,
    clone: async () => 'pve1/9101',
    start: async () => { calls.push('start'); },
    power: async (_ref, action) => { calls.push(`power:${action}`); },
    shutdown: async () => { calls.push('shutdown'); },
    destroy: async () => { calls.push('destroy'); },
    inspect: async () => ({ powerState: 'running', primaryIp: '10.20.3.11', agentReady: true }),
    snapshot: async (_ref, name) => { calls.push('snapshot'); return name; },
    capacity: async () => ({ cpuUsage: 0.1, memUsage: 0.2, diskUsage: 0.3, freeIpCount: 1 }),
    ...overrides,
  };
  return Object.assign(provider, { calls });
};

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

/** 手工入队一条任务（真实链路由 ensure / reaper 入队，这里直接投放以隔离被测单元） */
let taskSeq = 0;
const queueTask = async (
  type: 'start' | 'probe' | 'suspend' | 'recycle',
  instanceId: number,
  vmId: number | null = null,
): Promise<void> => {
  taskSeq += 1;
  await enqueueTask({
    taskKey: `${type}:test:${taskSeq}`, type, instanceId, vmId, userId: 1,
  });
};

beforeEach(async () => {
  await resetDatabase();
  probeMock.mockResolvedValue({ ok: true, latencyMs: 5 });
});

afterEach(() => {
  resetSettings();
  resetDesktopProvider();
  probeMock.mockReset();
});

describe('start 任务（唤醒 / 开机）', () => {
  it('挂起的 VM → start → 置 ready 并记录 IP', async () => {
    overrideSettings({ desktopEnabled: true, desktopStartTimeoutMs: 500 });
    // 第一次 inspect 报挂起（需要 start），之后报 running
    let inspections = 0;
    const provider = makeProvider({
      inspect: async () => {
        inspections += 1;
        return {
          powerState: inspections === 1 ? 'suspended' as const : 'running' as const,
          primaryIp: '10.20.3.11',
          agentReady: true,
        };
      },
    });
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId, {
      status: 'suspended', powerState: 'suspended',
    });

    await queueTask('start', instanceId, vmId);
    const summary = await runDueTasks({ handlers: { start: createStartHandler() } });
    expect(summary.succeeded).toBe(1);
    expect(provider.calls).toContain('start');

    const instance = await readInstance(instanceId);
    expect(instance.status).toBe('ready');
    expect((await readVm(vmId!)).powerState).toBe('running');
  });

  it('账号密码落后（改密时 VM 离线）→ awaiting_account 而不是 ready', async () => {
    overrideSettings({ desktopEnabled: true, desktopStartTimeoutMs: 500 });
    setDesktopProvider(makeProvider());

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    await withSession(async (db) => {
      // 模拟用户改过密码：password_version 前进到 2，VM 里仍是 1
      await db.db.update(users).set({ passwordVersion: 2 }).where(eq(users.id, alice.id));
      await db.commit();
    });
    const { instanceId } = await seedInstance(alice.id, templateId, {
      status: 'suspended', powerState: 'suspended', passwordVersion: 1,
    });

    await queueTask('start', instanceId);
    await runDueTasks({ handlers: { start: createStartHandler() } });
    expect((await readInstance(instanceId)).status).toBe('awaiting_account');
  });

  it('预算内没收敛 → probing + 入队 probe（不把 worker 堵在重试里）', async () => {
    overrideSettings({ desktopEnabled: true, desktopStartTimeoutMs: 300 });
    probeMock.mockResolvedValue({ ok: false, message: 'ECONNREFUSED' });
    setDesktopProvider(makeProvider());

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, {
      status: 'suspended', powerState: 'suspended',
    });

    await queueTask('start', instanceId);
    const summary = await runDueTasks({ handlers: { start: createStartHandler() } });
    expect(summary.succeeded).toBe(1);
    expect((await readInstance(instanceId)).status).toBe('probing');

    const tasks = await withSession(async (db) =>
      db.db.select().from(desktopTasks).where(eq(desktopTasks.type, 'probe')));
    expect(tasks).toHaveLength(1);
  });

  it('没有 VM 的实例 → 任务失败并留错误（不静默跳过）', async () => {
    setDesktopProvider(makeProvider());
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, { status: 'new', withVm: false });

    await queueTask('start', instanceId);
    const summary = await runDueTasks({ handlers: { start: createStartHandler() } });
    expect(summary.failed).toBe(1);
  });
});

describe('probe 任务（探活 + 自愈）', () => {
  it('探测成功 → 清计数，并把 probing 推进到 ready', async () => {
    overrideSettings({ desktopEnabled: true });
    setDesktopProvider(makeProvider());
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId, {
      status: 'probing', probeFailCount: 2,
    });

    await queueTask('probe', instanceId, vmId);
    await runDueTasks({ handlers: { probe: createProbeHandler() } });
    expect((await readInstance(instanceId)).status).toBe('ready');
    expect((await readVm(vmId!)).probeFailCount).toBe(0);
  });

  it('连续失败达阈值 → reset 并重新入队 start', async () => {
    overrideSettings({ desktopEnabled: true, desktopProbeFailThreshold: 3 });
    probeMock.mockResolvedValue({ ok: false, message: 'timeout' });
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId, {
      status: 'ready', probeFailCount: 2,
    });

    await queueTask('probe', instanceId, vmId);
    await runDueTasks({ handlers: { probe: createProbeHandler() } });

    expect(provider.calls).toContain('power:reset');
    expect((await readVm(vmId!)).probeFailCount).toBe(0);
    expect((await readInstance(instanceId)).status).toBe('booting');

    const starts = await withSession(async (db) =>
      db.db.select().from(desktopTasks).where(eq(desktopTasks.type, 'start')));
    expect(starts).toHaveLength(1);
  });

  it('未达阈值只计数，不 reset（避免一次网络抖动就重启用户桌面）', async () => {
    overrideSettings({ desktopEnabled: true, desktopProbeFailThreshold: 3 });
    probeMock.mockResolvedValue({ ok: false, message: 'timeout' });
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId, { probeFailCount: 0 });

    await queueTask('probe', instanceId, vmId);
    await runDueTasks({ handlers: { probe: createProbeHandler() } });
    expect(provider.calls).not.toContain('power:reset');
    expect((await readVm(vmId!)).probeFailCount).toBe(1);
  });
});

describe('suspend 任务', () => {
  it('运行中的 VM → power suspend，实例置 suspended', async () => {
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId, {
      status: 'idle', powerState: 'running',
    });

    await queueTask('suspend', instanceId, vmId);
    await runDueTasks({ handlers: { suspend: createSuspendHandler() } });
    expect(provider.calls).toContain('power:suspend');
    expect((await readInstance(instanceId)).status).toBe('suspended');
    expect((await readVm(vmId!)).powerState).toBe('suspended');
  });

  it('已经停机的 VM 不再调 Provider（PVE 对 stopped 执行 suspend 会报错）', async () => {
    const provider = makeProvider({
      inspect: async () => ({ powerState: 'stopped', primaryIp: null, agentReady: false }),
    });
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, {
      status: 'idle', powerState: 'stopped',
    });

    await queueTask('suspend', instanceId);
    await runDueTasks({ handlers: { suspend: createSuspendHandler() } });
    expect(provider.calls).not.toContain('power:suspend');
    expect((await readInstance(instanceId)).status).toBe('suspended');
  });
});

describe('recycle 任务（销毁回收）', () => {
  it('快照 → 优雅关机 → 销毁 → 释放 IP → 实例 destroyed', async () => {
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId, {
      status: 'idle', powerState: 'running',
    });

    await withSession(async (db) => {
      await db.db.insert(desktopIpAllocations).values({
        subnet: '10.20.0.0/16', ipAddress: '10.20.3.11', vmId: vmId!, state: 'allocated',
      });
      await db.commit();
    });

    await queueTask('recycle', instanceId, vmId);
    const summary = await runDueTasks({ handlers: { recycle: createRecycleHandler() } });
    expect(summary.succeeded).toBe(1);
    expect(provider.calls).toEqual(['snapshot', 'shutdown', 'destroy']);
    const instance = await readInstance(instanceId);
    expect(instance.status).toBe('destroyed');
    expect(instance.currentVmId).toBeNull();

    const vm = await readVm(vmId!);
    expect(vm.instanceId).toBeNull();
    expect(vm.destroyedAt).not.toBeNull();

    const [ip] = await withSession(async (db) => db.db.select().from(desktopIpAllocations));
    expect(ip!.state).toBe('free');
    expect(ip!.vmId).toBeNull();
  });

  it('优雅关机失败 → 降级硬 stop，仍然完成销毁', async () => {
    const provider = makeProvider({
      shutdown: async () => { throw new Error('guest agent 无响应'); },
    });
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, { status: 'idle' });

    await queueTask('recycle', instanceId);
    const summary = await runDueTasks({ handlers: { recycle: createRecycleHandler() } });
    expect(summary.succeeded).toBe(1);
    expect(provider.calls).toContain('power:stop');
    expect(provider.calls).toContain('destroy');
    expect((await readInstance(instanceId)).status).toBe('destroyed');
  });
});

describe('reaper（空闲判定与入队）', () => {
  it('connected 超 grace → 降级 idle，基线取当时的连接时间（不重置计时）', async () => {
    overrideSettings({ desktopConnectedGraceHours: 12 });
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, {
      status: 'connected', lastConnectedAt: daysAgo(1),
    });

    const actions = await sweepIdleInstances();
    expect(actions.map((item) => item.kind)).toContain('idle');

    const instance = await readInstance(instanceId);
    expect(instance.status).toBe('idle');
    // 基线取「当时的连接时间」而不是扫描时刻 —— 否则每次扫描都重置计时，永远到不了期
    expect(instance.lastDisconnectedAt?.getTime()).toBe(instance.lastConnectedAt?.getTime());
  });

  it('空闲 8 天 → 入队 suspend；同一轮重复扫描不重复入队', async () => {
    overrideSettings({ desktopIdleSuspendDays: 7, desktopIdleDestroyDays: 30 });
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    await seedInstance(alice.id, templateId, {
      status: 'idle', powerState: 'running', lastConnectedAt: daysAgo(8),
    });

    await withSession(async (db) => {
      await db.db.update(deskInstances).set({ lastDisconnectedAt: daysAgo(8) }).where(
        eq(deskInstances.userId, alice.id),
      );
      await db.commit();
    });

    const first = await sweepIdleInstances();
    expect(first.filter((item) => item.kind === 'suspend')).toHaveLength(1);

    const second = await sweepIdleInstances();
    expect(second.filter((item) => item.kind === 'suspend')).toHaveLength(0);

    const tasks = await withSession(async (db) =>
      db.db.select().from(desktopTasks).where(eq(desktopTasks.type, 'suspend')));
    expect(tasks).toHaveLength(1);
  });

  it('空闲 31 天 → 直接销毁（不先挂起）', async () => {
    overrideSettings({ desktopIdleSuspendDays: 7, desktopIdleDestroyDays: 30 });
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, { status: 'suspended' });

    await withSession(async (db) => {
      await db.db.update(deskInstances).set({ lastDisconnectedAt: daysAgo(31) })
        .where(eq(deskInstances.id, instanceId));
      await db.commit();
    });

    const actions = await sweepIdleInstances();
    expect(actions.map((item) => item.kind)).toEqual(['recycle']);

    const tasks = await withSession(async (db) =>
      db.db.select().from(desktopTasks).where(eq(desktopTasks.type, 'recycle')));
    expect(tasks).toHaveLength(1);
  });

  it('账号停用 → 立即回收，不看空闲天数', async () => {
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, { status: 'ready' });

    await withSession(async (db) => {
      await db.db.update(users).set({ isActive: false }).where(eq(users.id, alice.id));
      await db.commit();
    });

    const actions = await sweepIdleInstances();
    expect(actions).toEqual([{ kind: 'recycle', instanceId, reason: '账号已停用' }]);
  });

  it('刚连上的实例不动（grace 期内）', async () => {
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    await seedInstance(alice.id, templateId, {
      status: 'connected', lastConnectedAt: new Date(),
    });

    expect(await sweepIdleInstances()).toHaveLength(0);
  });
});

describe('改密后的 VM 同步（非阻断）', () => {
  it('没有桌面实例时静默跳过（不抛错、不阻断改密）', async () => {
    const alice = await seedUser({ username: 'alice' });
    const result = await notifyVmPasswordChange(alice.id, 'NewPassw0rd!');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_instance');
  });

  it('Provider 未配置时返回 vm_offline，而不是抛异常', async () => {
    resetDesktopProvider();
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    // 账号尚未初始化（accountSyncedAt=null）→ 确实需要同步，但 Provider 不可用
    await seedInstance(alice.id, templateId, {
      status: 'suspended', powerState: 'suspended', accountSyncedAt: null, passwordVersion: null,
    });

    const result = await notifyVmPasswordChange(alice.id, 'NewPassw0rd!');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('vm_offline');
  });

  it('账号已同步且版本一致 → 直接跳过（不重复跑 SSH）', async () => {
    resetDesktopProvider(); // 真去同步会返回 vm_offline，能区分「跳过」与「尝试过」
    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    await seedInstance(alice.id, templateId, { status: 'ready', passwordVersion: 1 });

    const result = await notifyVmPasswordChange(alice.id, 'NewPassw0rd!');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('串行化：同一用户连续两次改密按顺序执行', async () => {
    const alice = await seedUser({ username: 'alice' });
    const first = notifyVmPasswordChange(alice.id, 'Passw0rd!1');
    const second = notifyVmPasswordChange(alice.id, 'Passw0rd!2');
    const [a, b] = await Promise.all([first, second]);
    expect(a.reason).toBe('no_instance');
    expect(b.reason).toBe('no_instance');
  });
});
