/**
 * recycle 任务：销毁回收 —— 方案 9.5 / 9.7
 *
 * 销毁序列（快照 → 关机 → destroy → 释放 IPAM → 撤 guac READ → 解绑）已抽到
 * `../vm-teardown.ts`，因为 rebuild 要用**完全相同**的顺序。本文件只保留
 * 回收特有的语义：
 *   ① 实例置 `destroyed`（≠ 删行：审计与重建记录都挂在 desk_instances 上）
 *   ② `currentVmId = null` —— 这样 `ensureDesktop` 下次能建新实例
 *   ③ 写一条 `desktop_recycle` 审计
 *
 * ⚠️ 置 destroyed 会**释放活跃名额**（`uq_desk_instances_active_user` 不含 destroyed），
 * 这正是「回收后用户下次登录拿到新机器」的实现方式。rebuild 绝不能复用这个状态，
 * 否则重建失败时用户会同时拥有两条实例记录 —— 见 `rebuild.ts` 的说明。
 */
import { eq } from 'drizzle-orm';
import { deskInstances } from '../../db/schema.js';
import { withSession } from '../../db/session.js';
import { recordAudit } from '../../audit.js';
import { getSettings } from '../../config/env.js';
import type { ClaimedTask } from '../queue.js';
import { DesktopError } from '../service.js';
import { teardownVm } from '../vm-teardown.js';
import type { TaskHandler } from '../worker.js';
import { loadTaskContext } from './context.js';

export const createRecycleHandler = (): TaskHandler => async (task: ClaimedTask): Promise<void> => {
  const { instanceId } = task;
  if (instanceId === null) throw new DesktopError('NO_INSTANCE', 'recycle 任务缺少 instance_id');

  const { instance, vm } = await loadTaskContext(instanceId);
  const { desktopRecycleSnapshot } = getSettings();

  if (vm !== null) {
    await teardownVm({ instanceId, vm, reason: 'recycle' });
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
