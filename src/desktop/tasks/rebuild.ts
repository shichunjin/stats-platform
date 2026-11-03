/**
 * rebuild 任务：从模板重建桌面 —— 方案 9.7 / 6.4
 *
 * 触发场景有三类，语义相同（都是「这台 VM 不可信了，换一台新的」）：
 *   - 规格变更（A14：运行中不能热调 CPU/内存，只能重建）
 *   - 模板升级（新 login.ps1 / 新软件 → 换到 v(n+1) 模板）
 *   - 系统盘疑似损坏的排障兜底（管理端手动触发）
 *
 * ## 与 create / recycle 的分工
 *
 * 销毁那一段**不**复用 recycle 任务，而是共用 `teardownVm()`：
 * recycle 会把实例置 `destroyed`，而 `destroyed` 不在「活跃实例」的部分唯一索引里 ——
 * 于是重建失败时用户会**同时拥有一条 destroyed 实例和一条新建实例**，
 * 丢掉全部历史（重建计数、连接次数、审计归属）。所以本任务全程把实例钉在
 * `provisioning`（属于活跃状态），失败也只置 `failed`（仍占名额）。
 *
 * 克隆那一段**不**复用 create 任务：create 的 ⓪ 步是「已有 VM 就接着跑」的幂等恢复，
 * 而 rebuild 的语义恰恰相反 —— 每次都必须是一台新克隆的机器。硬抽公共函数会让
 * 两条路径都长出互相冲突的 if，宁可重复 40 行。
 *
 * ## 三个容易漏的点
 *
 * 1. **账号必须清空**（`accountSyncedAt = null`）。模板里只有 Administrator，
 *    新 VM 上没有用户的 Windows 账号 —— 不清空就会停在假的 `ready`，
 *    用户点连接直接认证失败（A16 在 rebuild 场景的复现）。
 *    清空后 `isAccountStale()` 返回 true，用户下一次登录（登录接口持有明文密码）
 *    会自动补建账号，这是目前唯一能补的时机。
 * 2. **先销毁再克隆**。同节点资源未必容得下两台；先 clone 会在资源紧张时直接失败，
 *    而「短暂没有桌面」比「资源死锁 + 两台半成品」好收拾。
 * 3. **IP 必须先释放再分配**。teardownVm 释放旧地址，之后才向 IPAM 要新的；
 *    顺序反过来会在池子只剩一个地址时把自己锁死。
 */
import { eq } from 'drizzle-orm';
import { getSettings } from '../../config/env.js';
import {
  deskInstances, desktopIpAllocations, desktopVms,
  type DeskInstanceStatus, type DesktopVmPowerState,
} from '../../db/schema.js';
import { withSession } from '../../db/session.js';
import { recordAudit } from '../../audit.js';
import type { ClaimedTask } from '../queue.js';
import { toSpecUpdate } from '../provider/types.js';
import { allocateIpFromPool, DesktopError, syncGuacForInstance } from '../service.js';
import { teardownVm } from '../vm-teardown.js';
import type { TaskHandler } from '../worker.js';
import { loadTaskContext, requireProvider } from './context.js';

/** 落库的错误摘要长度（`last_error` 是 text，但管理页只显示前几行） */
const errorSummary = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).slice(0, 500);

export const createRebuildHandler = (): TaskHandler => async (task: ClaimedTask): Promise<void> => {
  const { instanceId } = task;
  if (instanceId === null) throw new DesktopError('NO_INSTANCE', 'rebuild 任务缺少 instance_id');

  const context = await loadTaskContext(instanceId);
  const {
    instance, vm, template, quota, username,
  } = context;

  // ① 前置校验：先拒绝，再动手。配额禁重建时**绝不能**先销毁旧机
  if (quota !== null && !quota.allowRebuild) {
    throw new DesktopError(
      'REBUILD_DENIED',
      `配额 ${quota.code} 禁止重建（allow_rebuild=false），请先在 /admin/desktop-quotas 打开`,
    );
  }
  if (template.status !== 'active') {
    throw new DesktopError(
      'TEMPLATE_UNAVAILABLE',
      `模板 ${template.code} 当前状态为 ${template.status}，不能作为重建源`,
    );
  }

  // ② 规格重算：按**当前**配额档位，不是沿用实例上的旧值（A12）
  const spec = toSpecUpdate({ template, quota });

  // ③ 拆旧机。destroyedAt 非空说明它其实已经被回收过（状态不一致的历史数据），
  //    此时再调 destroy 会 404 拖住重建 —— 直接跳过，靠 ⑦ 覆盖 currentVmId 解绑。
  if (vm !== null && vm.destroyedAt === null) {
    await teardownVm({ instanceId, vm, reason: 'rebuild' });
  }

  const provider = requireProvider();
  const { desktopSubnet } = getSettings();
  const startedAt = new Date();
  const oldVmRef = vm?.providerRef ?? null;

  try {
    // ④ 钉住 provisioning + 清账号 + 写新规格。清账号放在这里（而非结束时）：
    //    万一后面 clone 失败，实例状态已经如实反映「没有可用账号」。
    await withSession(async (db) => {
      await db.db.update(deskInstances).set({
        status: 'provisioning',
        currentVmId: null,
        specVcpu: spec.specVcpu,
        specMemoryMb: spec.specMemoryMb,
        accountSyncedAt: null,
        passwordVersion: null,
        provisionStartedAt: startedAt,
        provisionFinishedAt: null,
        rebuildCount: instance.rebuildCount + 1,
        lastError: null,
        lastErrorAt: null,
      }).where(eq(deskInstances.id, instanceId));
      await db.commit();
    });

    // ⑤ 先要 IP：拿不到就不必白克隆一台机器
    const ip = desktopSubnet === '' ? null : await allocateIpFromPool(desktopSubnet);
    if (desktopSubnet !== '' && ip === null) {
      throw new DesktopError('NO_IP', `IP 池（${desktopSubnet}）已耗尽，无法重建桌面`);
    }

    // ⑥ 克隆（名字沿用 create 的规则，保证同一实例在 PVE 里名字稳定）
    const providerRef = await provider.clone(template, {
      name: `${template.code}-${instance.id}`,
      vcpu: spec.specVcpu,
      memoryMb: spec.specMemoryMb,
      ...(ip === null ? {} : { staticIp: ip.ipAddress }),
      ...(template.storage === null ? {} : { storage: template.storage }),
      ...(template.providerNode === null ? {} : { targetNode: template.providerNode }),
    });

    const node = providerRef.includes('/') ? providerRef.split('/')[0]! : null;

    // ⑦ 落 desktop_vms + 绑 IP + 指回实例（先落库再开机，避免孤儿 VM）
    const vmId = await withSession(async (db) => {
      const [row] = await db.db.insert(desktopVms).values({
        instanceId: instance.id,
        templateId: template.id,
        provider: template.provider,
        providerRef,
        ...(node === null ? {} : { providerNode: node }),
        name: `${template.code}-${instance.id}`,
        ...(ip === null ? {} : { primaryIp: ip.ipAddress }),
        vcpu: spec.specVcpu,
        memoryMb: spec.specMemoryMb,
        diskGb: template.diskGb,
        powerState: 'stopped',
        rdpPort: 3389,
      }).returning();

      if (ip !== null) {
        await db.db.update(desktopIpAllocations)
          .set({ vmId: row!.id, state: 'allocated' })
          .where(eq(desktopIpAllocations.id, ip.id));
      }

      await db.db.update(deskInstances)
        .set({ currentVmId: row!.id, status: 'booting' })
        .where(eq(deskInstances.id, instanceId));

      await db.commit();
      return row!.id;
    });

    // ⑧ 开机 + 回读（不等 3389：与 create 一致，连接时由 start 任务收敛）
    await provider.start(providerRef);
    const inspected = await provider.inspect(providerRef);
    const finalIp = inspected.primaryIp ?? ip?.ipAddress ?? null;

    await withSession(async (db) => {
      await db.db.update(desktopVms).set({
        powerState: inspected.powerState as DesktopVmPowerState,
        ...(finalIp === null ? {} : { primaryIp: finalIp }),
        agentReady: inspected.agentReady,
        lastProbeAt: new Date(),
        startedAt: new Date(),
        probeFailCount: 0,
      }).where(eq(desktopVms.id, vmId));
      await db.commit();
    });

    // ⑨ Guacamole 连接改指新 IP（一人一连接，回收后复用同一 connection_id）
    if (finalIp !== null && username !== '') {
      await syncGuacForInstance(instance.userId, instanceId, username, {
        hostname: finalIp,
        port: 3389,
      });
    }

    // ⑩ 终态：账号必然没同步（新 VM 里没有用户账号），如实上报 awaiting_account
    const status: DeskInstanceStatus = 'awaiting_account';
    await withSession(async (db) => {
      await db.db.update(deskInstances).set({
        status,
        provisionFinishedAt: new Date(),
      }).where(eq(deskInstances.id, instanceId));

      await recordAudit(db, {
        userId: instance.userId,
        action: 'desktop_rebuild',
        detail: `重建云桌面 instance_id=${instanceId}, from_template=${template.code}, `
          + `old_vm=${oldVmRef ?? 'none'}, new_vm=${providerRef}, `
          + `spec=${spec.specVcpu}c/${spec.specMemoryMb}MB, rebuild_count=${instance.rebuildCount + 1}`,
      });
      await db.commit();
    });

    console.info('[desktop-rebuild] 实例 %s 已重建（%s → %s，%sc/%sMB）',
      instanceId, oldVmRef ?? 'none', providerRef, spec.specVcpu, spec.specMemoryMb);
  } catch (error) {
    // 失败置 failed（仍占活跃名额），下次重试会把状态改回 provisioning 再来一遍
    await withSession(async (db) => {
      await db.db.update(deskInstances).set({
        status: 'failed',
        lastError: errorSummary(error),
        lastErrorAt: new Date(),
      }).where(eq(deskInstances.id, instanceId));
      await db.commit();
    }).catch((dbError: unknown) => {
      console.error('[desktop-rebuild] 写回失败状态也失败 instance=%s: %s', instanceId, dbError);
    });
    throw error;
  }
};
