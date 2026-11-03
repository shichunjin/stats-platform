/**
 * VM 销毁序列 —— `recycle`（回收）与 `rebuild`（重建）共用的**唯一**实现。
 *
 * 为什么必须共用：这里的每一步顺序都是「先留退路，再动手」，漏一步或换序的
 * 后果都不在业务代码里、而是在运维现场：
 *   ① 快照（失败继续）         —— 少了就没有恢复点
 *   ② 优雅关机 → 降级硬 stop   —— 少了 DELETE 会失败并留下孤儿磁盘
 *   ③ destroy(purge=1)        —— 少了 VM 还在，名字冲突导致下次 rebuild 失败
 *   ④ 释放 IPAM               —— 少了池子会随重建次数线性泄漏（见下）
 *   ⑤ 撤销 Guacamole READ     —— 少了用户能在网关里看到一条连不通的连接
 *   ⑥ 解绑 desktop_vms        —— 少了唯一索引与「当前 VM」指针会错乱
 *
 * ⚠️ **IPAM 泄漏（本轮修复的真 bug）**：`desktop_ip_allocations.vm_id` 此前从没人写过，
 * 而回收时按 `vm_id = ?` 释放 —— 条件永不成立，IP 一旦分配就再也不回池。
 * 现在双条件释放（`vm_id` 或 `ip_address` 命中都算），并在 create/rebuild 落库时
 * 显式回填 `vm_id`；单条重建看不出来，靠 reaper 反复回收才会暴露成「池子被吃光」。
 *
 * ⚠️ 用户数据不在 VM 上（方案 3.2：数据留中心文件服务器），所以销毁不丢数据 ——
 * 这是「30 天销毁」与「rebuild 直接换机」都敢做的前提。若哪天改成 VM 本地盘，
 * 这里必须先加导出/留存。
 */
import { eq, or } from 'drizzle-orm';
import { getSettings } from '../config/env.js';
import {
  desktopIpAllocations, desktopVms, guacConnectionMap, type DesktopVm,
} from '../db/schema.js';
import { withSession } from '../db/session.js';
import { revokeConnectionRead } from '../integrations/guac.js';
import { getDesktopProvider } from './provider/proxmox.js';
import { DesktopError } from './service.js';

/** 快照名前缀：`recycle-45-20261103` / `rebuild-45-20261103`，人工在 PVE 里一眼能认出来 */
export type TeardownReason = 'recycle' | 'rebuild';

export interface TeardownInput {
  readonly instanceId: number;
  readonly vm: DesktopVm;
  readonly reason: TeardownReason;
}

export interface TeardownOutcome {
  /** 快照名；未开启快照或快照失败为 null（失败不阻断销毁） */
  readonly snapshotRef: string | null;
  /** 是否真的释放到了 IPAM 行（false = 这条 IP 不是 IPAM 分配的，或历史数据没绑 vm_id） */
  readonly ipReleased: boolean;
}

const snapshotName = (reason: TeardownReason, instanceId: number, at: Date): string =>
  `${reason}-${instanceId}-${at.toISOString().slice(0, 10).replace(/-/g, '')}`;

/**
 * 销毁一台 VM 并把所有指向它的外部状态清干净。
 *
 * **不碰 `desk_instances`**：回收要置 `destroyed`、重建要置 `provisioning`，
 * 那是调用方的语义（也决定了是否释放「活跃实例」名额），混进来会让两条路径互相牵制。
 */
export const teardownVm = async (input: TeardownInput): Promise<TeardownOutcome> => {
  const { instanceId, vm, reason } = input;

  const provider = getDesktopProvider();
  if (provider === null) {
    throw new DesktopError(
      'NO_PROVIDER',
      '未配置 Proxmox（PROXMOX_API_URL / PROXMOX_TOKEN_ID），无法销毁桌面',
    );
  }

  const { desktopRecycleSnapshot, desktopShutdownTimeoutMs } = getSettings();

  // ① 快照：失败只告警 —— 存不下快照不该阻止回收，否则这台 VM 永远删不掉
  let snapshotRef: string | null = null;
  if (desktopRecycleSnapshot) {
    try {
      const name = snapshotName(reason, instanceId, new Date());
      await provider.snapshot(vm.providerRef, name);
      snapshotRef = name;
      await withSession(async (db) => {
        await db.db.update(desktopVms).set({ snapshotRef: name }).where(eq(desktopVms.id, vm.id));
        await db.commit();
      });
    } catch (error) {
      console.warn('[desktop-teardown] 快照失败（继续销毁）vm=%s: %s', vm.providerRef, error);
    }
  }

  // ② 优雅关机失败只降级，不阻断：销毁是「必须完成」的动作，卡住比硬关机更糟
  try {
    await provider.shutdown(vm.providerRef, desktopShutdownTimeoutMs);
  } catch (error) {
    console.warn('[desktop-teardown] 优雅关机失败，降级为硬 stop vm=%s: %s', vm.providerRef, error);
    await provider.power(vm.providerRef, 'stop').catch((stopError: unknown) => {
      console.warn('[desktop-teardown] 硬 stop 也失败（继续尝试销毁）vm=%s: %s', vm.providerRef, stopError);
    });
  }

  // ③ 销毁
  await provider.destroy(vm.providerRef);

  // ④ 释放 IPAM + ⑥ 解绑 VM（同一事务：两者都是「这台机器已经不存在」的记录）
  const ipReleased = await withSession(async (db) => {
    // 双条件：vm_id 是正解；ip_address 兜住「老数据没绑 vm_id」与「手工配的同一地址」
    const clauses = [eq(desktopIpAllocations.vmId, vm.id)];
    if (vm.primaryIp !== null) {
      clauses.push(eq(desktopIpAllocations.ipAddress, vm.primaryIp));
    }
    const released = await db.db.update(desktopIpAllocations).set({
      state: 'free',
      vmId: null,
      releasedAt: new Date(),
    }).where(or(...clauses)).returning({ id: desktopIpAllocations.id });

    await db.db.update(desktopVms).set({
      instanceId: null,
      powerState: 'stopped',
      destroyedAt: new Date(),
      stoppedAt: vm.stoppedAt ?? new Date(),
    }).where(eq(desktopVms.id, vm.id));

    await db.commit();
    return released.length > 0;
  });

  if (!ipReleased && vm.primaryIp !== null) {
    // 不报错：静态 IP 方案下 IP 可能是 DHCP 保留的，本来就不在 IPAM 表里
    console.info(
      '[desktop-teardown] IP %s 未在 IPAM 中登记（或已释放），instance=%s',
      vm.primaryIp, instanceId,
    );
  }

  // ⑤ 撤销 Guacamole READ：跨库操作失败只告警 —— 连接指向已销毁的 IP，误点会报错但无风险
  const [map] = await withSession(async (db) => db.db.select().from(guacConnectionMap)
    .where(eq(guacConnectionMap.instanceId, instanceId)).limit(1));

  if (map) {
    await revokeConnectionRead(map.guacConnectionId).catch((error: unknown) => {
      console.warn('[desktop-teardown] 撤销 guac READ 失败 connection=%s: %s',
        map.guacConnectionId, error);
    });
    await withSession(async (db) => {
      await db.db.update(guacConnectionMap)
        .set({ readGranted: false, revokedAt: new Date() })
        .where(eq(guacConnectionMap.id, map.id));
      await db.commit();
    });
  }

  return { snapshotRef, ipReleased };
};
