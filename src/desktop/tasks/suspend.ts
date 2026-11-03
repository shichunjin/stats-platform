/**
 * suspend 任务：空闲挂起 —— 方案 9.5（idle 7d → 挂起，释放内存）
 *
 * Proxmox 的 `status/suspend` 是 **suspend to disk**（vmstate 落盘、VM 变 stopped），
 * 下次 `start` 直接 resume，因此：
 *  - 内存真的释放了（宿主机压力随之下降）；
 *  - 磁盘与 VM 配置全部保留，用户数据不受影响；
 *  - 代价是唤醒后 Windows 时间漂移 + SMB 会话已断（A15）。
 *
 * 不要用 `stop` 代替：关机再开会走完整 Windows 启动，且用户桌面上的未保存文档
 * 直接没了 —— 挂起的语义才是「离开一会儿」。
 */
import { eq } from 'drizzle-orm';
import { deskInstances, desktopVms } from '../../db/schema.js';
import { withSession } from '../../db/session.js';
import type { ClaimedTask } from '../queue.js';
import { DesktopError } from '../service.js';
import type { TaskHandler } from '../worker.js';
import { loadTaskContext, requireProvider } from './context.js';

export const createSuspendHandler = (): TaskHandler => async (task: ClaimedTask): Promise<void> => {
  const { instanceId } = task;
  if (instanceId === null) throw new DesktopError('NO_INSTANCE', 'suspend 任务缺少 instance_id');

  const { instance, vm } = await loadTaskContext(instanceId);

  // 没有 VM 的实例是残留数据（create 失败/中途销毁）：直接收尾，避免它永久占着名额
  if (vm === null) {
    await withSession(async (db) => {
      await db.db.update(deskInstances).set({ status: 'destroyed' })
        .where(eq(deskInstances.id, instanceId));
      await db.commit();
    });
    return;
  }

  const provider = requireProvider();
  const inspected = await provider.inspect(vm.providerRef);

  // 已在非运行态就跳过 Provider 调用：PVE 对 stopped 的 VM 执行 suspend 会报错
  if (inspected.powerState === 'running') {
    await provider.power(vm.providerRef, 'suspend');
  }

  await withSession(async (db) => {
    await db.db.update(desktopVms).set({
      powerState: 'suspended',
      stoppedAt: new Date(),
      lastProbeAt: new Date(),
    }).where(eq(desktopVms.id, vm.id));

    await db.db.update(deskInstances).set({
      status: 'suspended',
      lastDisconnectedAt: instance.lastDisconnectedAt ?? new Date(),
    }).where(eq(deskInstances.id, instanceId));
    await db.commit();
  });

  console.info('[desktop-suspend] 实例 %s 已挂起（vm=%s）', instanceId, vm.providerRef);
};
