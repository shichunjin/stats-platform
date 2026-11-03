/**
 * recycle 任务：销毁回收 —— 方案 9.5 / 9.7
 *
 * 顺序不能变（每一步都是「先留退路，再动手」）：
 *   ① 快照（可选，失败继续 —— 快照存不下不该阻止回收）
 *   ② 优雅关机 → 超时降级硬 stop（否则 DELETE 会失败并留孤儿磁盘）
 *   ③ destroy（purge=1 连带清配置与未引用磁盘）
 *   ④ 释放 IPAM
 *   ⑤ 撤销 Guacamole READ（不断授权的话，用户还能在网关里看到一条连不通的连接）
 *   ⑥ 解绑 VM + 实例置 destroyed（**保留 desk_instances 行**：审计与重建记录都在上面）
 *
 * ⚠️ 用户数据不在 VM 上（方案 3.2：数据留中心文件服务器），所以销毁 VM 不丢数据 ——
 * 这是「30 天销毁」敢做成默认策略的前提。若哪天改成 VM 本地盘，这里必须加导出/留存步骤。
 */
import { eq } from 'drizzle-orm';
import { getSettings } from '../../config/env.js';
import { deskInstances, desktopIpAllocations, desktopVms, guacConnectionMap } from '../../db/schema.js';
import { withSession } from '../../db/session.js';
import { recordAudit } from '../../audit.js';
import { revokeConnectionRead } from '../../integrations/guac.js';
import type { ClaimedTask } from '../queue.js';
import { DesktopError } from '../service.js';
import type { TaskHandler } from '../worker.js';
import { loadTaskContext, requireProvider } from './context.js';

/** 快照名：PVE 里按 'recycle-<instance>-<yyyymmdd>' 便于人工识别与批量清理 */
const snapshotName = (instanceId: number, at: Date): string =>
  `recycle-${instanceId}-${at.toISOString().slice(0, 10).replace(/-/g, '')}`;

export const createRecycleHandler = (): TaskHandler => async (task: ClaimedTask): Promise<void> => {
  const { instanceId } = task;
  if (instanceId === null) throw new DesktopError('NO_INSTANCE', 'recycle 任务缺少 instance_id');

  const { instance, vm } = await loadTaskContext(instanceId);
  const { desktopRecycleSnapshot, desktopShutdownTimeoutMs } = getSettings();

  if (vm !== null) {
    const provider = requireProvider();

    if (desktopRecycleSnapshot) {
      try {
        const name = snapshotName(instanceId, new Date());
        await provider.snapshot(vm.providerRef, name);
        await withSession(async (db) => {
          await db.db.update(desktopVms).set({ snapshotRef: name }).where(eq(desktopVms.id, vm.id));
          await db.commit();
        });
      } catch (error) {
        console.warn('[desktop-recycle] 快照失败（继续回收）vm=%s: %s', vm.providerRef, error);
      }
    }

    // 优雅关机失败只降级，不阻断：回收是「必须完成」的动作，卡住比硬关机更糟
    try {
      await provider.shutdown(vm.providerRef, desktopShutdownTimeoutMs);
    } catch (error) {
      console.warn('[desktop-recycle] 优雅关机失败，降级为硬 stop vm=%s: %s', vm.providerRef, error);
      await provider.power(vm.providerRef, 'stop').catch((stopError: unknown) => {
        console.warn('[desktop-recycle] 硬 stop 也失败（继续尝试销毁）vm=%s: %s', vm.providerRef, stopError);
      });
    }

    await provider.destroy(vm.providerRef);

    await withSession(async (db) => {
      await db.db.update(desktopIpAllocations)
        .set({ state: 'free', vmId: null, releasedAt: new Date() })
        .where(eq(desktopIpAllocations.vmId, vm.id));

      await db.db.update(desktopVms).set({
        instanceId: null,
        powerState: 'stopped',
        destroyedAt: new Date(),
        stoppedAt: vm.stoppedAt ?? new Date(),
      }).where(eq(desktopVms.id, vm.id));
      await db.commit();
    });

    // 撤销 Guacamole READ：跨库操作失败只告警 —— 连接指向已销毁的 IP，误点会报错但不会有风险
    const [map] = await withSession(async (db) => db.db.select().from(guacConnectionMap)
      .where(eq(guacConnectionMap.instanceId, instanceId)).limit(1));

    if (map) {
      await revokeConnectionRead(map.guacConnectionId).catch((error: unknown) => {
        console.warn('[desktop-recycle] 撤销 guac READ 失败 connection=%s: %s', map.guacConnectionId, error);
      });
      await withSession(async (db) => {
        await db.db.update(guacConnectionMap)
          .set({ readGranted: false, revokedAt: new Date() })
          .where(eq(guacConnectionMap.id, map.id));
        await db.commit();
      });
    }
  }

  await withSession(async (db) => {
    await db.db.update(deskInstances)
      .set({ status: 'destroyed', currentVmId: null })
      .where(eq(deskInstances.id, instanceId));

    await recordAudit(db, {
      userId: instance.userId,
      action: 'desktop_recycle',
      detail: `回收云桌面 instance_id=${instanceId}, vm_ref=${vm?.providerRef ?? 'none'}, `
        + `snapshot=${desktopRecycleSnapshot ? 'yes' : 'no'}`,
    });
    await db.commit();
  });

  console.info('[desktop-recycle] 实例 %s 已销毁（vm=%s）', instanceId, vm?.providerRef ?? 'none');
};
