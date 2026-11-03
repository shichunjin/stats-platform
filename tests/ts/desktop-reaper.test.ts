/**
 * 空闲扫描器（reaper）—— docs/multi-vm-desktop-plan.md 9.5
 *
 * 本轮新增「VM 机龄到线 → 强制重建」，并顺手补了一个真实缺口：
 * `awaiting_account` 此前**完全不在扫描范围**，于是「建好了但用户没登录过」的桌面
 * 既不会被挂起也不会被销毁 —— 越积越多的内存占用，而且没有任何告警会提示。
 *
 * 判定优先级是语义的一部分（③ 销毁 > ④ 重建 > ⑤ 挂起）：
 * 能销毁就别浪费一次克隆；到了换机周期就别先挂起再等下一次唤醒。
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetSettings } from '../../src/config/env.js';
import {
  deskInstances, desktopQuotas, desktopTasks, desktopTemplates, desktopVms,
  type DeskInstanceStatus,
} from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { sweepIdleInstances } from '../../src/desktop/reaper.js';
import { seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

const insertTemplate = async (): Promise<number> => withSession(async (db) => {
  const [row] = await db.db.insert(desktopTemplates).values({
    code: 'win2022-stats-v1',
    name: '统计软件桌面 v1',
    provider: 'proxmox',
    providerRef: 'pve1/9001',
    vcpu: 4,
    memoryMb: 8192,
    diskGb: 120,
    isDefault: true,
  }).returning();
  await db.commit();
  return row!.id;
});

const insertQuota = async (
  templateId: number,
  overrides: { readonly allowRebuild?: boolean; readonly rebuildAfterDays?: number } = {},
): Promise<number> => withSession(async (db) => {
  const [row] = await db.db.insert(desktopQuotas).values({
    code: 'default',
    name: '默认档',
    maxVcpu: 8,
    maxMemoryMb: 16384,
    maxIdleDays: 7,
    destroyAfterIdleDays: 30,
    rebuildAfterDays: overrides.rebuildAfterDays ?? 180,
    allowRebuild: overrides.allowRebuild ?? true,
    templateId,
  }).returning();
  await db.commit();
  return row!.id;
});

interface SeedOptions {
  readonly status?: DeskInstanceStatus;
  readonly quotaId?: number | null;
  /** 当前 VM 的创建时间（重建计时基准） */
  readonly vmCreatedAt?: Date;
  /** 最后断开时间（空闲计天基准） */
  readonly lastDisconnectedAt?: Date;
  readonly withVm?: boolean;
}

const seedInstance = async (
  templateId: number,
  options: SeedOptions = {},
): Promise<{ instanceId: number; userId: number }> => {
  const user = await seedUser({ username: `u${Math.random().toString(36).slice(2, 8)}` });
  return withSession(async (db) => {
    const [instance] = await db.db.insert(deskInstances).values({
      userId: user.id,
      templateId,
      quotaId: options.quotaId ?? null,
      status: options.status ?? 'ready',
      specVcpu: 4,
      specMemoryMb: 8192,
      ...(options.lastDisconnectedAt === undefined
        ? {}
        : { lastDisconnectedAt: options.lastDisconnectedAt }),
    }).returning();

    if (options.withVm !== false) {
      const [vm] = await db.db.insert(desktopVms).values({
        instanceId: instance!.id,
        templateId,
        provider: 'proxmox',
        providerRef: 'pve1/9101',
        name: 'DESK-x',
        primaryIp: '10.20.3.11',
        powerState: 'running',
        ...(options.vmCreatedAt === undefined ? {} : { createdAt: options.vmCreatedAt }),
      }).returning();
      await db.db.update(deskInstances).set({ currentVmId: vm!.id })
        .where(eq(deskInstances.id, instance!.id));
    }

    await db.commit();
    return { instanceId: instance!.id, userId: user.id };
  });
};

const queuedTypes = async (): Promise<string[]> => withSession(async (db) => {
  const rows = await db.db.select().from(desktopTasks);
  return rows.map((row) => row.type);
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  resetSettings();
});

describe('reaper：VM 机龄到线 → 强制重建', () => {
  it('机龄 200 天 ≥ 180 → 入队 rebuild，但不改状态（交给任务执行）', async () => {
    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId);
    const { instanceId } = await seedInstance(templateId, {
      quotaId, vmCreatedAt: daysAgo(200), lastDisconnectedAt: daysAgo(1),
    });

    const actions = await sweepIdleInstances();
    expect(actions).toEqual([
      { kind: 'rebuild', instanceId, reason: 'VM 已运行 200 天 ≥ 180' },
    ]);
    expect(await queuedTypes()).toEqual(['rebuild']);

    // 状态保持 ready —— 重建是 worker 的事，扫描器不预测结果
    const [instance] = await withSession(async (db) => db.db.select().from(deskInstances)
      .where(eq(deskInstances.id, instanceId)).limit(1));
    expect(instance!.status).toBe('ready');
  });

  it('同一天重复扫描不重复入队（task_key 按天幂等）', async () => {
    const templateId = await insertTemplate();
    const { instanceId } = await seedInstance(templateId, {
      vmCreatedAt: daysAgo(200), lastDisconnectedAt: daysAgo(1),
    });

    expect((await sweepIdleInstances()).length).toBe(1);
    expect((await sweepIdleInstances()).length).toBe(0);
    expect(await queuedTypes()).toEqual(['rebuild']);

    const [task] = await withSession(async (db) => db.db.select().from(desktopTasks));
    expect(task!.taskKey).toMatch(new RegExp(`^rebuild:instance:${instanceId}:\\d{8}$`, 'u'));
  });

  it('配额 allow_rebuild=false → 不入队（入队只会失败并污染任务表）', async () => {
    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId, { allowRebuild: false });
    await seedInstance(templateId, {
      quotaId, vmCreatedAt: daysAgo(400), lastDisconnectedAt: daysAgo(1),
    });

    expect(await sweepIdleInstances()).toEqual([]);
    expect(await queuedTypes()).toEqual([]);
  });

  it('用户在线（connected）→ 跳过，不把人踢下线', async () => {
    const templateId = await insertTemplate();
    // connected 且刚连过：既不会降级 idle，也不会被重建
    await seedInstance(templateId, {
      status: 'connected',
      vmCreatedAt: daysAgo(200),
      lastDisconnectedAt: daysAgo(1),
    });

    expect(await sweepIdleInstances()).toEqual([]);
    expect(await queuedTypes()).toEqual([]);
  });

  it('机龄未到 → 不重建，但空闲超销毁线仍然回收（③ 优先于 ④）', async () => {
    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId, { rebuildAfterDays: 180 });
    await seedInstance(templateId, {
      quotaId, status: 'idle', vmCreatedAt: daysAgo(100), lastDisconnectedAt: daysAgo(40),
    });

    const actions = await sweepIdleInstances();
    expect(actions).toHaveLength(1);
    expect(actions[0]!.kind).toBe('recycle');
    expect(await queuedTypes()).toEqual(['recycle']);
  });

  it('销毁线被配得很长时，重建先命中（④ 优先于 ⑤）', async () => {
    const templateId = await insertTemplate();
    const quotaId = await insertQuota(templateId, { rebuildAfterDays: 180 });
    await withSession(async (db) => {
      await db.db.update(desktopQuotas)
        .set({ destroyAfterIdleDays: 365, maxIdleDays: 7 })
        .where(eq(desktopQuotas.id, quotaId));
      await db.commit();
    });
    await seedInstance(templateId, {
      quotaId, status: 'idle', vmCreatedAt: daysAgo(200), lastDisconnectedAt: daysAgo(10),
    });

    const actions = await sweepIdleInstances();
    expect(actions.map((item) => item.kind)).toEqual(['rebuild']);
  });
});

describe('reaper：awaiting_account 纳入扫描（此前是缺口）', () => {
  it('空闲 10 天 ≥ 7 → 挂起', async () => {
    const templateId = await insertTemplate();
    await seedInstance(templateId, {
      status: 'awaiting_account', lastDisconnectedAt: daysAgo(10),
    });

    const actions = await sweepIdleInstances();
    expect(actions.map((item) => item.kind)).toEqual(['suspend']);
  });

  it('空闲 40 天 ≥ 30 → 回收（不再永久占资源）', async () => {
    const templateId = await insertTemplate();
    await seedInstance(templateId, {
      status: 'awaiting_account', lastDisconnectedAt: daysAgo(40),
    });

    const actions = await sweepIdleInstances();
    expect(actions.map((item) => item.kind)).toEqual(['recycle']);
  });
});

describe('reaper：没有 VM 的实例', () => {
  it('current_vm_id 为空 → 不因机龄入队 rebuild（没有机龄可言）', async () => {
    const templateId = await insertTemplate();
    await seedInstance(templateId, {
      status: 'failed', withVm: false, lastDisconnectedAt: daysAgo(1),
    });

    // failed 不在扫描范围（要等人工处理），断言的是「没有误入队」
    expect(await sweepIdleInstances()).toEqual([]);
    expect(await queuedTypes()).toEqual([]);
  });
});
