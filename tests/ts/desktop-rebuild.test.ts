/**
 * rebuild 任务 —— docs/multi-vm-desktop-plan.md 9.7 / 6.4
 *
 * 重建是唯一「先销毁再创建」的动作，因此这里断言的重点不是「调没调 Provider」，
 * 而是**顺序与可恢复性**：
 *   - 前置校验失败时旧机必须完好（否则拒绝重建反而成了灾难）；
 *   - 销毁后实例仍钉在活跃状态（`destroyed` 会释放唯一索引名额，产生第二条实例行）；
 *   - 新 VM 的账号信息必须被清空（模板里没有用户账号，A16 的复现点）；
 *   - 规格取**当前**配额而不是旧值（A12）。
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideSettings, resetSettings } from '../../src/config/env.js';
import {
  deskInstances, desktopIpAllocations, desktopQuotas, desktopTemplates, desktopVms,
  type DeskInstanceStatus,
} from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { enqueueTask } from '../../src/desktop/queue.js';
import { resetDesktopProvider, setDesktopProvider } from '../../src/desktop/provider/proxmox.js';
import type { DesktopProvider } from '../../src/desktop/provider/types.js';
import { createRebuildHandler } from '../../src/desktop/tasks/rebuild.js';
import { runDueTasks } from '../../src/desktop/worker.js';
import { findAudit, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

interface SeedOptions {
  readonly status?: DeskInstanceStatus;
  readonly withVm?: boolean;
  readonly ip?: string | null;
  readonly accountSyncedAt?: Date | null;
  readonly passwordVersion?: number | null;
  readonly quotaId?: number | null;
}

const insertTemplate = async (status: 'active' | 'disabled' = 'active'): Promise<number> =>
  withSession(async (db) => {
    const [row] = await db.db.insert(desktopTemplates).values({
      code: 'win2022-stats-v3',
      name: '统计软件桌面 v3',
      provider: 'proxmox',
      providerRef: 'pve1/9003',
      providerNode: 'pve1',
      vcpu: 4,
      memoryMb: 8192,
      diskGb: 120,
      storage: 'local-lvm',
      isDefault: true,
      status,
    }).returning();
    await db.commit();
    return row!.id;
  });

const insertQuota = async (
  templateId: number,
  options: { readonly defaultVcpu?: number | null; readonly allowRebuild?: boolean } = {},
): Promise<number> => withSession(async (db) => {
  const [row] = await db.db.insert(desktopQuotas).values({
    code: 'vip',
    name: '高配',
    defaultVcpu: options.defaultVcpu ?? null,
    defaultMemoryMb: 16384,
    allowRebuild: options.allowRebuild ?? true,
    templateId,
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
    quotaId: options.quotaId ?? null,
    accountSyncedAt: options.accountSyncedAt === undefined ? new Date() : options.accountSyncedAt,
    passwordVersion: options.passwordVersion === undefined ? 1 : options.passwordVersion,
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
    providerNode: 'pve1',
    name: 'win2022-stats-v3-1',
    primaryIp: options.ip === undefined ? '10.20.3.11' : options.ip,
    powerState: 'running',
    vcpu: 4,
    memoryMb: 8192,
  }).returning();

  await db.db.update(deskInstances).set({ currentVmId: vm!.id })
    .where(eq(deskInstances.id, instance!.id));
  await db.commit();
  return { instanceId: instance!.id, vmId: vm!.id };
});

const makeProvider = (
  overrides: Partial<DesktopProvider> = {},
  newRef = 'pve1/9202',
): DesktopProvider & { readonly calls: string[] } => {
  const calls: string[] = [];
  const provider: DesktopProvider = {
    kind: 'proxmox',
    validateTemplate: async () => true,
    clone: async () => { calls.push('clone'); return newRef; },
    start: async () => { calls.push('start'); },
    power: async (_ref, action) => { calls.push(`power:${action}`); },
    shutdown: async () => { calls.push('shutdown'); },
    destroy: async () => { calls.push('destroy'); },
    // 故意让 inspect 拿不到 IP：验证 fallback 到 IPAM 分配值这条路径
    inspect: async () => ({ powerState: 'running', primaryIp: null, agentReady: true }),
    snapshot: async (_ref, name) => { calls.push('snapshot'); return name; },
    capacity: async () => ({ cpuUsage: 0.1, memUsage: 0.2, diskUsage: 0.3, freeIpCount: 1 }),
    ...overrides,
  };
  return Object.assign(provider, { calls });
};

const readInstance = async (id: number) => withSession(async (db) => {
  const [row] = await db.db.select().from(deskInstances).where(eq(deskInstances.id, id)).limit(1);
  return row!;
});

const readVm = async (id: number) => withSession(async (db) => {
  const [row] = await db.db.select().from(desktopVms).where(eq(desktopVms.id, id)).limit(1);
  return row!;
});

const allVms = async () => withSession(async (db) => db.db.select().from(desktopVms));
const allIps = async () => withSession(async (db) => db.db.select().from(desktopIpAllocations));

/** 池子里放一个空闲地址（desktopSubnet 已配置时，重建必须先拿到 IP 才会去克隆） */
const insertFreeIp = async (address: string): Promise<void> => withSession(async (db) => {
  await db.db.insert(desktopIpAllocations).values({
    subnet: '10.20.0.0/16', ipAddress: address, vmId: null, state: 'free',
  });
  await db.commit();
});

let taskSeq = 0;
const queueRebuild = async (instanceId: number): Promise<void> => {
  taskSeq += 1;
  await enqueueTask({
    taskKey: `rebuild:test:${taskSeq}`, type: 'rebuild', instanceId, userId: 1,
  });
};

const runRebuild = async () => runDueTasks({ handlers: { rebuild: createRebuildHandler() } });

beforeEach(async () => {
  await resetDatabase();
  overrideSettings({
    desktopEnabled: true,
    desktopSubnet: '10.20.0.0/16',
    desktopRecycleSnapshot: true,
    desktopShutdownTimeoutMs: 100,
  });
});

afterEach(() => {
  resetSettings();
  resetDesktopProvider();
});

describe('rebuild 任务（从模板重建）', () => {
  it('销毁旧机 → 按当前配额重算规格 → 克隆新机 → 清空账号 → awaiting_account', async () => {
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId, { defaultVcpu: 8 });
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId, { quotaId });

    // 旧地址登记在 IPAM 并绑到旧 VM：重建必须先释放它，再由 allocate 取回
    await withSession(async (db) => {
      await db.db.insert(desktopIpAllocations).values({
        subnet: '10.20.0.0/16', ipAddress: '10.20.3.11', vmId: vmId!, state: 'allocated',
      });
      await db.commit();
    });

    await queueRebuild(instanceId);
    const summary = await runRebuild();
    expect(summary.succeeded).toBe(1);

    // 顺序：先留退路（快照）→ 关机 → 销毁 → 克隆 → 开机
    expect(provider.calls).toEqual(['snapshot', 'shutdown', 'destroy', 'clone', 'start']);

    const instance = await readInstance(instanceId);
    expect(instance.status).toBe('awaiting_account');
    // A12：规格按配额重算（default_vcpu=8），不是沿用旧的 4
    expect(instance.specVcpu).toBe(8);
    expect(instance.specMemoryMb).toBe(16384);
    // A16：新 VM 里没有用户账号，必须清空，否则会停在假的 ready
    expect(instance.accountSyncedAt).toBeNull();
    expect(instance.passwordVersion).toBeNull();
    expect(instance.rebuildCount).toBe(1);
    expect(instance.currentVmId).not.toBe(vmId);

    // 旧 VM：解绑 + 标记销毁时间
    const oldVm = await readVm(vmId!);
    expect(oldVm.instanceId).toBeNull();
    expect(oldVm.destroyedAt).not.toBeNull();
    expect(oldVm.snapshotRef).toMatch(/^rebuild-/u);

    // 新 VM：绑定实例、带上配额规格、IP 来自 IPAM
    const vms = await allVms();
    expect(vms).toHaveLength(2);
    const newVm = vms.find((row) => row.id === instance.currentVmId)!;
    expect(newVm.instanceId).toBe(instanceId);
    expect(newVm.providerRef).toBe('pve1/9202');
    expect(newVm.vcpu).toBe(8);
    expect(newVm.memoryMb).toBe(16384);
    expect(newVm.primaryIp).toBe('10.20.3.11');
    expect(newVm.powerState).toBe('running');

    // IP 不泄漏：仍是一条记录，且已改绑到新 VM
    const ips = await allIps();
    expect(ips).toHaveLength(1);
    expect(ips[0]!.state).toBe('allocated');
    expect(ips[0]!.vmId).toBe(newVm.id);

    const audit = await findAudit('desktop_rebuild');
    expect(audit?.userId).toBe(alice.id);
    expect(audit?.detail).toContain('pve1/9202');
  });

  it('配额禁止重建 → 直接失败，旧机完好（不做任何销毁）', async () => {
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId, { allowRebuild: false });
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId, { quotaId });

    await queueRebuild(instanceId);
    const summary = await runRebuild();
    expect(summary.failed).toBe(1);
    expect(provider.calls).toEqual([]);

    const instance = await readInstance(instanceId);
    expect(instance.status).toBe('ready');
    expect(instance.currentVmId).toBe(vmId);
    expect((await readVm(vmId!)).destroyedAt).toBeNull();
  });

  it('模板已下线 → 失败，不销毁旧机', async () => {
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate('disabled');
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId);

    await queueRebuild(instanceId);
    const summary = await runRebuild();
    expect(summary.failed).toBe(1);
    expect(provider.calls).toEqual([]);
    expect((await readInstance(instanceId)).status).toBe('ready');
  });

  it('克隆失败 → 实例置 failed 并留错误摘要（旧机已销毁，如实反映）', async () => {
    const provider = makeProvider({
      clone: async () => { throw new Error('storage local-lvm 空间不足'); },
    });
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId, vmId } = await seedInstance(alice.id, templateId);
    await insertFreeIp('10.20.3.30');

    await queueRebuild(instanceId);
    const summary = await runRebuild();
    expect(summary.failed).toBe(1);

    const instance = await readInstance(instanceId);
    expect(instance.status).toBe('failed');
    expect(instance.currentVmId).toBeNull();
    expect(instance.lastError).toContain('空间不足');
    expect((await readVm(vmId!)).destroyedAt).not.toBeNull();
  });

  it('实例还没有 VM（首次创建就失败）→ 跳过销毁直接克隆', async () => {
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, {
      status: 'failed', withVm: false,
    });
    await insertFreeIp('10.20.3.31');

    await queueRebuild(instanceId);
    const summary = await runRebuild();
    expect(summary.succeeded).toBe(1);
    expect(provider.calls).toEqual(['clone', 'start']);
    expect((await readInstance(instanceId)).status).toBe('awaiting_account');
  });

  it('IP 池耗尽 → 失败且不白克隆（旧机已销毁，池子是唯一原因）', async () => {
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, { ip: '10.20.9.99' });

    await queueRebuild(instanceId);
    const summary = await runRebuild();
    expect(summary.failed).toBe(1);
    expect(provider.calls).not.toContain('clone');

    const instance = await readInstance(instanceId);
    expect(instance.status).toBe('failed');
    expect(instance.lastError).toContain('IP 池');
  });

  it('历史数据没绑 vm_id 时按 primary_ip 兜底释放（IPAM 泄漏修复）', async () => {
    const provider = makeProvider();
    setDesktopProvider(provider);

    const templateId = await insertTemplate();
    const alice = await seedUser({ username: 'alice' });
    const { instanceId } = await seedInstance(alice.id, templateId, { ip: '10.20.3.21' });

    // 模拟 create 老版本：allocated 但 vm_id 为 null
    await withSession(async (db) => {
      await db.db.insert(desktopIpAllocations).values({
        subnet: '10.20.0.0/16', ipAddress: '10.20.3.21', vmId: null, state: 'allocated',
      });
      await db.commit();
    });

    await queueRebuild(instanceId);
    expect((await runRebuild()).succeeded).toBe(1);

    const ips = await allIps();
    expect(ips).toHaveLength(1);
    expect(ips[0]!.state).toBe('allocated');
    expect(ips[0]!.vmId).not.toBeNull();
  });
});
