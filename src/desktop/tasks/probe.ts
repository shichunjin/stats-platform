/**
 * probe 任务：探活与自愈 —— 方案 9.8 / 9.10
 *
 * 「探活」与「自愈」是两个动作，但必须看同一份计数：
 *  - 探活：TCP 3389 通不通，通就把 `probing` 推进到 `ready / awaiting_account`；
 *  - 自愈：连续 `desktopProbeFailThreshold` 次不通 → 硬 reset（蓝屏/服务僵死）。
 *
 * ⚠️ 不做「探不通就重建」：重建要重装账号、重指 Guacamole，代价高且会丢用户在
 * 桌面上的临时状态。先靠 reset 兜住绝大多数僵死，只有在 reset 也救不回来时
 * 才由运维通过 `/admin/desktops/{id}/recycle` 人工介入。
 */
import { eq } from 'drizzle-orm';
import { getSettings } from '../../config/env.js';
import {
  deskInstances, desktopVms, type DeskInstanceStatus, type DesktopVmPowerState,
} from '../../db/schema.js';
import { withSession } from '../../db/session.js';
import { probeTcp } from '../provider/probe.js';
import { enqueueTask, type ClaimedTask } from '../queue.js';
import { DesktopError } from '../service.js';
import type { TaskHandler } from '../worker.js';
import { isAccountStale, loadTaskContext, requireProvider } from './context.js';

export const createProbeHandler = (): TaskHandler => async (task: ClaimedTask): Promise<void> => {
  const { instanceId } = task;
  if (instanceId === null) throw new DesktopError('NO_INSTANCE', 'probe 任务缺少 instance_id');

  const context = await loadTaskContext(instanceId);
  const { instance, vm } = context;
  // create 还没跑完（没有 VM）时探活无事可做，直接结束 —— 不是错误
  if (vm === null) return;

  const provider = requireProvider();
  const { desktopProbeTimeoutMs, desktopProbeFailThreshold } = getSettings();

  const inspected = await provider.inspect(vm.providerRef);
  const ip = inspected.primaryIp ?? vm.primaryIp;

  const failCount = vm.probeFailCount;
  const persistVm = async (patch: {
    readonly powerState: DesktopVmPowerState;
    readonly probeFailCount: number;
    readonly agentReady?: boolean;
    readonly primaryIp?: string | null;
  }): Promise<void> => {
    await withSession(async (db) => {
      await db.db.update(desktopVms).set({ ...patch, lastProbeAt: new Date() })
        .where(eq(desktopVms.id, vm.id));
      await db.commit();
    });
  };

  // ① VM 不在运行：可连性必然为假。计数达阈值就唤醒一次（挂起/意外关机的自愈）
  if (inspected.powerState !== 'running') {
    const nextCount = failCount + 1;
    await persistVm({
      powerState: inspected.powerState,
      probeFailCount: nextCount >= desktopProbeFailThreshold ? 0 : nextCount,
      agentReady: false,
    });

    if (nextCount >= desktopProbeFailThreshold && instance.status !== 'destroyed') {
      console.warn('[desktop-probe] 实例 %s 的 VM 连续 %s 次不可用，触发唤醒', instanceId, nextCount);
      await withSession(async (db) => {
        await db.db.update(deskInstances).set({ status: 'booting' })
          .where(eq(deskInstances.id, instanceId));
        await db.commit();
      });
      await enqueueTask({
        taskKey: `start:instance:${instanceId}:${Math.floor(Date.now() / 60_000)}`,
        type: 'start',
        instanceId,
        vmId: vm.id,
        userId: instance.userId,
      });
    }
    return;
  }

  // ② 运行中但没有 IP：Agent 尚未上报，等下一轮
  if (ip === null) {
    await persistVm({ powerState: 'running', probeFailCount: failCount, agentReady: inspected.agentReady });
    return;
  }

  const probe = await probeTcp(ip, vm.rdpPort, desktopProbeTimeoutMs);

  if (probe.ok) {
    await persistVm({
      powerState: 'running', probeFailCount: 0, agentReady: inspected.agentReady, primaryIp: ip,
    });

    // 探通了才允许把 probing 推进到可连状态（start 任务超时降级过来的就是这条路径）
    if (instance.status === 'probing') {
      const stale = isAccountStale(instance, context.userPasswordVersion);
      const status: DeskInstanceStatus = stale ? 'awaiting_account' : 'ready';
      await withSession(async (db) => {
        await db.db.update(deskInstances).set({ status }).where(eq(deskInstances.id, instanceId));
        await db.commit();
      });
    }
    return;
  }

  const nextCount = failCount + 1;
  await persistVm({
    powerState: 'running',
    probeFailCount: nextCount >= desktopProbeFailThreshold ? 0 : nextCount,
    agentReady: inspected.agentReady,
  });

  if (nextCount < desktopProbeFailThreshold) return;

  // ③ 连续失败达阈值：硬重置（Guest Agent 可能已僵死，但 hypervisor 层 reset 仍有效）
  console.warn(
    '[desktop-probe] 实例 %s 连续 %s 次 RDP 探测失败（%s），执行 reset',
    instanceId, nextCount, probe.message,
  );
  await withSession(async (db) => {
    await db.db.update(deskInstances).set({
      status: 'booting',
      lastError: `连续 ${nextCount} 次 RDP 探测失败：${probe.message}`,
      lastErrorAt: new Date(),
    }).where(eq(deskInstances.id, instanceId));
    await db.commit();
  });
  await provider.power(vm.providerRef, 'reset');

  // 重置后重新等一次（延迟执行，避免 reset 还没生效就开机）
  await enqueueTask({
    taskKey: `start:instance:${instanceId}:${Math.floor(Date.now() / 60_000)}`,
    type: 'start',
    instanceId,
    vmId: vm.id,
    userId: instance.userId,
    delayMs: 30_000,
  });
};
