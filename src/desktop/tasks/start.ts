/**
 * start 任务：开机 / 唤醒 —— 方案 5.4 第 5 步、9.5（挂起唤醒）
 *
 * 与 create 任务的分工：create 负责「从模板克隆出一台机器」，start 负责
 * 「让一台已存在的机器可用」。用户第二次点连接走的是 start，不是 create。
 *
 * 收敛策略（很关键，别改成一路抛错重试）：
 * 任务有 `desktopStartTimeoutMs` 的总预算，期间等在 running + 等 RDP 3389 可连。
 * 预算内没收敛就**正常结束**任务，把实例置 `probing` 并入队一条 probe 继续跟进 ——
 * 因为 worker 是 batch=1 的单线程，让一条任务卡在重试里会把整个队列堵住。
 *
 * A15（挂起唤醒的两个副作用）在这里落地：
 *  - 唤醒后 Windows 时钟停走过，需 NTP 同步（模板侧配置，代码不处理）；
 *  - SMB 会话已被文件服务器断开，W:/Z: 会短暂红叉后自动重连 —— 这依赖
 *    「VM 本地账号密码 = 文件服务器账号密码」（方案 A′），改密同步没做对就会全红。
 */
import { eq } from 'drizzle-orm';
import { getSettings } from '../../config/env.js';
import { deskInstances, desktopVms, type DeskInstanceStatus } from '../../db/schema.js';
import { withSession } from '../../db/session.js';
import { ensureVmRunning } from '../provider/lifecycle.js';
import { probeTcp } from '../provider/probe.js';
import { enqueueTask, type ClaimedTask } from '../queue.js';
import { DesktopError, syncGuacForInstance } from '../service.js';
import type { TaskHandler } from '../worker.js';
import { isAccountStale, loadTaskContext, requireProvider } from './context.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** 在总预算内等 IP 与 3389 同时就绪；返回 null 表示没等到 */
const waitUntilConnectable = async (
  provider: ReturnType<typeof requireProvider>,
  ref: string,
  fallbackIp: string | null,
  port: number,
  deadline: number,
  pollIntervalMs = 5_000,
): Promise<{ ip: string; agentReady: boolean } | null> => {
  for (;;) {
    const inspected = await provider.inspect(ref);
    const ip = inspected.primaryIp ?? fallbackIp;
    if (ip !== null) {
      const probe = await probeTcp(ip, port, getSettings().desktopProbeTimeoutMs);
      if (probe.ok) return { ip, agentReady: inspected.agentReady };
    }
    if (Date.now() >= deadline) return null;
    // 剩余预算不足一个轮询周期就只等到期（否则短预算的测试/紧急场景会白等整轮）
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
};

export const createStartHandler = (): TaskHandler => async (task: ClaimedTask): Promise<void> => {
  const { instanceId } = task;
  if (instanceId === null) throw new DesktopError('NO_INSTANCE', 'start 任务缺少 instance_id');

  const context = await loadTaskContext(instanceId);
  const { instance, vm } = context;
  if (vm === null) {
    throw new DesktopError('NO_VM', `实例 ${instanceId} 尚未克隆出 VM，不能直接 start（请先跑 create 任务）`);
  }

  const provider = requireProvider();
  const { desktopStartTimeoutMs } = getSettings();
  const deadline = Date.now() + desktopStartTimeoutMs;

  const run = await ensureVmRunning(provider, vm.providerRef, desktopStartTimeoutMs);
  if (!run.ok) {
    throw new DesktopError(
      'BOOT_TIMEOUT',
      `VM ${vm.providerRef} 未在 ${desktopStartTimeoutMs}ms 内进入 running（最后状态 ${run.lastPowerState}）`,
    );
  }

  const ready = await waitUntilConnectable(
    provider, vm.providerRef, vm.primaryIp, vm.rdpPort, deadline,
  );

  if (ready === null) {
    // 没收敛：交给 probe 任务继续跟（自愈靠连续的探测失败计数）
    await withSession(async (db) => {
      await db.db.update(deskInstances)
        .set({ status: 'probing' }).where(eq(deskInstances.id, instanceId));
      await db.db.update(desktopVms).set({
        powerState: 'running',
        lastProbeAt: new Date(),
        ...(vm.primaryIp === null ? {} : { primaryIp: vm.primaryIp }),
      }).where(eq(desktopVms.id, vm.id));
      await db.commit();
    });
    await enqueueTask({
      taskKey: `probe:instance:${instanceId}:${Math.floor(Date.now() / 60_000)}`,
      type: 'probe',
      instanceId,
      vmId: vm.id,
      userId: instance.userId,
      delayMs: 30_000,
    });
    return;
  }

  // Guacamole 连接改指当前 IP（重建后 IP 可能变），失败不影响开机结论
  if (context.username !== '') {
    await syncGuacForInstance(instance.userId, instanceId, context.username, {
      hostname: ready.ip,
      port: vm.rdpPort,
    });
  }

  const stale = isAccountStale(instance, context.userPasswordVersion);
  const status: DeskInstanceStatus = stale ? 'awaiting_account' : 'ready';

  await withSession(async (db) => {
    await db.db.update(desktopVms).set({
      powerState: 'running',
      primaryIp: ready.ip,
      agentReady: ready.agentReady,
      lastProbeAt: new Date(),
      probeFailCount: 0,
      startedAt: vm.startedAt ?? new Date(),
    }).where(eq(desktopVms.id, vm.id));

    await db.db.update(deskInstances).set({ status, lastError: null, lastErrorAt: null })
      .where(eq(deskInstances.id, instanceId));
    await db.commit();
  });
};
