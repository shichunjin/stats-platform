/**
 * create 任务：克隆 VM 并把它接入 Guacamole —— 方案 6.4「初始化」流水线
 *
 * 步骤（与方案 3.3 一致，⓪~⑦）：
 *   ⓪ 幂等检查：该实例是否已经有 VM（上次跑一半崩了）
 *   ① clone（Provider 内部按 A13 做 clone → config(cores,memory) → 记录规格）
 *   ② 落 desktop_vms 并绑定 instance
 *   ③ start
 *   ④ inspect 回读 IP / power_state / agent_ready
 *   ⑤ 写 Guacamole 连接（hostname = VM IP）
 *   ⑥ 置 awaiting_account（VM 里还没有 Windows 账号，等注册/改密链路同步）
 *
 * ⚠️ 第 ⑥ 步是方案 A′ 的直接后果：VM 账号密码 = 平台密码，而此刻拿不到明文。
 * 所以「VM 建好了」≠「用户能登进去」，状态绝不能写成 ready。
 */
import { eq } from 'drizzle-orm';
import {
  deskInstances, desktopTemplates, desktopVms, users,
  type DeskInstanceStatus, type DesktopVmPowerState,
} from '../../db/schema.js';
import { withSession } from '../../db/session.js';
import { DesktopError, syncGuacForInstance } from '../service.js';
import { getDesktopProvider } from '../provider/proxmox.js';
import type { ClaimedTask } from '../queue.js';
import type { TaskHandler } from '../worker.js';

/** 从 requestJson 里安全取字符串（入参来自库里的 jsonb，不可信） */
const readString = (source: Readonly<Record<string, unknown>> | null, key: string): string | null => {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

interface InstanceRow {
  readonly id: number;
  readonly userId: number;
  readonly templateId: number;
  readonly specVcpu: number | null;
  readonly specMemoryMb: number | null;
  readonly currentVmId: number | null;
  readonly accountSyncedAt: Date | null;
}

export const createCreateHandler = (): TaskHandler => async (task: ClaimedTask): Promise<void> => {
  const { instanceId } = task;
  if (instanceId === null) {
    throw new DesktopError('NO_INSTANCE', 'create 任务缺少 instance_id');
  }

  const provider = getDesktopProvider();
  if (provider === null) {
    throw new DesktopError('NO_PROVIDER', '未配置 Proxmox（PROXMOX_API_URL / PROXMOX_TOKEN_ID），无法创建桌面');
  }

  // ⓪ 幂等：已有 VM 就接着往下跑（start/inspect 都是幂等的），绝不重复克隆
  const before = await withSession(async (db) => {
    const [instance] = await db.db.select({
      id: deskInstances.id,
      userId: deskInstances.userId,
      templateId: deskInstances.templateId,
      specVcpu: deskInstances.specVcpu,
      specMemoryMb: deskInstances.specMemoryMb,
      currentVmId: deskInstances.currentVmId,
      accountSyncedAt: deskInstances.accountSyncedAt,
    }).from(deskInstances).where(eq(deskInstances.id, instanceId)).limit(1);
    if (!instance) throw new DesktopError('NO_INSTANCE', `桌面实例不存在: ${instanceId}`);

    const [user] = await db.db.select({ username: users.username })
      .from(users).where(eq(users.id, instance.userId)).limit(1);
    const [template] = await db.db.select().from(desktopTemplates)
      .where(eq(desktopTemplates.id, instance.templateId)).limit(1);
    if (!template) throw new DesktopError('NO_TEMPLATE', `模板不存在: ${instance.templateId}`);

    const [existingVm] = await db.db.select().from(desktopVms)
      .where(eq(desktopVms.instanceId, instance.id)).limit(1);

    return { instance: instance as InstanceRow, username: user?.username ?? '', template, existingVm };
  });

  const { instance, template, existingVm } = before;

  let vmId = existingVm?.id ?? 0;
  let providerRef = existingVm?.providerRef ?? '';

  if (!existingVm) {
    // ① 克隆（spec 用实例上已算好的 spec_*，不再重算 —— 重算可能因配额变更而漂移）
    const spec = {
      name: `${template.code}-${instance.id}`,
      vcpu: instance.specVcpu ?? template.vcpu,
      memoryMb: instance.specMemoryMb ?? template.memoryMb,
      ...(readString(task.requestJson, 'staticIp') === null
        ? {}
        : { staticIp: readString(task.requestJson, 'staticIp')! }),
      ...(template.storage === null ? {} : { storage: template.storage }),
      ...(template.providerNode === null ? {} : { targetNode: template.providerNode }),
    };
    providerRef = await provider.clone(template, spec);

    // ref 形如 '<node>/<vmid>'，node 单独落列以便多节点时定位
    const node = providerRef.includes('/') ? providerRef.split('/')[0]! : null;

    // ② 落库并绑定（先落库再开机：否则开机后崩了就留下「Provider 有 VM、库里没有」的孤儿）
    vmId = await withSession(async (db) => {
      const [vm] = await db.db.insert(desktopVms).values({
        instanceId: instance.id,
        templateId: template.id,
        provider: template.provider,
        providerRef,
        ...(node === null ? {} : { providerNode: node }),
        name: spec.name,
        ...(spec.staticIp === undefined ? {} : { primaryIp: spec.staticIp }),
        vcpu: spec.vcpu,
        memoryMb: spec.memoryMb,
        diskGb: template.diskGb,
        powerState: 'stopped',
        rdpPort: 3389,
      }).returning();

      await db.db.update(deskInstances)
        .set({ currentVmId: vm!.id, status: 'provisioning', provisionStartedAt: new Date() })
        .where(eq(deskInstances.id, instance.id));

      await db.commit();
      return vm!.id;
    });
  }

  // ③ 开机
  await provider.start(providerRef);
  await withSession(async (db) => {
    await db.db.update(deskInstances)
      .set({ status: 'booting' }).where(eq(deskInstances.id, instance.id));
    await db.db.update(desktopVms)
      .set({ powerState: 'running', startedAt: new Date() }).where(eq(desktopVms.id, vmId));
    await db.commit();
  });

  // ④ 回读真实状态（Agent 可能还没起来，primaryIp 拿不到就沿用静态 IP）
  const inspected = await provider.inspect(providerRef);
  const finalIp = inspected.primaryIp ?? readString(task.requestJson, 'staticIp');
  await withSession(async (db) => {
    await db.db.update(desktopVms).set({
      powerState: inspected.powerState as DesktopVmPowerState,
      ...(finalIp === null ? {} : { primaryIp: finalIp }),
      agentReady: inspected.agentReady,
      lastProbeAt: new Date(),
    }).where(eq(desktopVms.id, vmId));
    await db.commit();
  });

  // ⑤ 把 Guacamole 连接指向这台 VM（没有 IP 就跳过，等 probe 任务补）
  if (finalIp !== null && before.username !== '') {
    await syncGuacForInstance(instance.userId, instance.id, before.username, {
      hostname: finalIp,
      port: 3389,
    });
  }

  // ⑥ 终态：账号没同步 = awaiting_account
  const status: DeskInstanceStatus = instance.accountSyncedAt === null ? 'awaiting_account' : 'ready';
  await withSession(async (db) => {
    await db.db.update(deskInstances)
      .set({ status, provisionFinishedAt: new Date() })
      .where(eq(deskInstances.id, instance.id));
    await db.commit();
  });
};
