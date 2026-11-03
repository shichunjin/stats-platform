/**
 * DMS 服务层 —— docs/multi-vm-desktop-plan.md 6.4（`/desktop/ensure` 的业务主体）
 *
 * 三条贯穿本文件的约束：
 *  1. **灰度**：`users.desktop_mode='rds'`（默认）的用户一律走原共享桌面，
 *     本文件的任何失败都不能影响他们（所以 ensure 在开关关闭时直接返回 rds，不去查库）。
 *  2. **懒创建**：首次调用才建实例与任务；VM 在 worker 里异步克隆，
 *     所以这里返回的是「已受理」而不是「已就绪」。
 *  3. **幂等**：同一用户重复调用不会创建第二个活跃实例 —— 靠
 *     `uq_desk_instances_active_user` 部分唯一索引 + 任务 `task_key` 双重保证。
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getSettings } from '../config/env.js';
import type { AppDatabase } from '../db/client.js';
import {
  deskInstances, desktopIpAllocations, desktopTemplates, desktopVms,
  guacConnectionMap, users, type DeskInstance, type DeskInstanceStatus,
  type DesktopQuota, type DesktopTemplate, type DesktopVm, type User,
} from '../db/schema.js';
import { withSession } from '../db/session.js';
import { ensureUserConnectionDetail, guacSyncEnabled, hashParameters, buildRdpParameters } from '../integrations/guac.js';
import { ensureVmRunning } from './provider/lifecycle.js';
import { getDesktopProvider } from './provider/proxmox.js';
import { resolveVmSpec } from './provider/types.js';
import { enqueueTask } from './queue.js';

/** 「仍占着用户桌面名额」的状态；error/destroyed 会释放名额，可重新分配。
 *  ⚠️ 不用 readonly：drizzle 的 inArray 只接受可变数组 */
const ACTIVE_STATUSES: DeskInstanceStatus[] = [
  'new', 'provisioning', 'configuring', 'booting', 'probing', 'ready',
  'awaiting_account', 'connected', 'idle', 'suspended', 'failed',
];

/** 处于该状态的实例已经能连 RDP 了（前端据此决定是否可跳转） */
export const isConnectable = (status: DeskInstanceStatus): boolean =>
  status === 'ready' || status === 'awaiting_account';

export class DesktopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DesktopError';
    this.code = code;
  }
}

/** 该用户是否走专属 VM（含全局开关与用户级开关） */
export const isVmMode = (user: Pick<User, 'desktopMode' | 'desktopEnabled' | 'isActive'>): boolean =>
  getSettings().desktopEnabled
  && user.isActive
  && user.desktopEnabled
  && user.desktopMode === 'vm';

export interface ActiveInstance {
  readonly instance: DeskInstance;
  readonly vm: DesktopVm | null;
}

/** 事务句柄（只暴露本文件用到的部分，便于测试替身） */
interface DbLike {
  readonly db: AppDatabase;
}

/** 查用户当前活跃实例（含承载的 VM） */
export const findActiveInstance = async (userId: number): Promise<ActiveInstance | null> =>
  withSession(async (db) => {
    const [instance] = await db.db.select().from(deskInstances)
      .where(and(
        eq(deskInstances.userId, userId),
        inArray(deskInstances.status, ACTIVE_STATUSES),
      ))
      .orderBy(desc(deskInstances.createdAt))
      .limit(1);
    if (!instance) return null;

    const vm = instance.currentVmId === null
      ? null
      : await db.db.query.desktopVms.findFirst({
        where: (row, { eq: eqOp }) => eqOp(row.id, instance.currentVmId!),
      }) ?? null;

    return { instance, vm };
  });

/** 事务内占用一个空闲 IP（SKIP LOCKED，并发分配不会撞号） */
const allocateIp = async (
  db: DbLike,
  subnet: string,
): Promise<{ id: number; ipAddress: string } | null> => {
  const result = await db.db.execute(sql`
    UPDATE desktop_ip_allocations
    SET state = 'allocated', allocated_at = now()
    WHERE id = (
      SELECT id FROM desktop_ip_allocations
      WHERE subnet = ${subnet} AND state = 'free'
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, ip_address
  `);
  const rows = (result as unknown as { rows: readonly { id: string | number; ip_address: string }[] }).rows ?? [];
  if (rows.length === 0) return null;
  return { id: Number(rows[0]!.id), ipAddress: rows[0]!.ip_address };
};

/**
 * 从 IPAM 池取一个空闲地址（独立事务）。
 *
 * `ensureDesktop` 用的是内部版本（分配与建实例同一个事务，失败一起回滚）；
 * rebuild 是「已有实例换机」，没有新实例要建，因此单开一个事务先占地址再克隆 ——
 * 拿不到地址就不该动旧机器，这个先后顺序是本函数存在的意义。
 */
export const allocateIpFromPool = async (
  subnet: string,
): Promise<{ readonly id: number; readonly ipAddress: string } | null> =>
  withSession(async (db) => {
    const allocated = await allocateIp(db, subnet);
    await db.commit();
    return allocated;
  });

const pickTemplate = async (
  db: DbLike,
  quota: DesktopQuota | null,
): Promise<DesktopTemplate> => {
  if (quota?.templateId) {
    const [byQuota] = await db.db.select().from(desktopTemplates)
      .where(eq(desktopTemplates.id, quota.templateId)).limit(1);
    if (byQuota) return byQuota;
  }
  const [fallback] = await db.db.select().from(desktopTemplates)
    .where(and(eq(desktopTemplates.isDefault, true), eq(desktopTemplates.status, 'active')))
    .limit(1);
  if (!fallback) throw new DesktopError('NO_TEMPLATE', '没有可用的桌面模板（请先在 desktop_templates 中录入并置为默认）');
  return fallback;
};

export type EnsureOutcome =
  | { readonly mode: 'rds' }
  | {
    readonly mode: 'vm';
    readonly instanceId: number;
    readonly status: DeskInstanceStatus;
    /** 本次是否新建了实例（false = 命中已有实例） */
    readonly created: boolean;
    /** 入队的任务 id（-1 = 命中幂等键，未重复入队） */
    readonly taskId: number;
    readonly vmIp: string | null;
  };

/**
 * 确保用户有一台可用桌面（懒创建入口）。
 *
 * 分两个事务：`desk_instances` 先提交，再入队 —— 不能反过来，
 * 因为 `desktop_tasks.instance_id` 是外键，同一事务里先后插入没问题，
 * 但跨连接的事务（enqueueTask 自带会话）看不到未提交的 instance，会撞 FK。
 */
export const ensureDesktop = async (user: User): Promise<EnsureOutcome> => {
  if (!isVmMode(user)) return { mode: 'rds' };

  const existing = await findActiveInstance(user.id);
  if (existing) {
    return {
      mode: 'vm',
      instanceId: existing.instance.id,
      status: existing.instance.status,
      created: false,
      taskId: -1,
      vmIp: existing.vm?.primaryIp ?? null,
    };
  }

  const { desktopSubnet, desktopNamePrefix } = getSettings();

  const created = await withSession(async (db) => {
    const quota = user.desktopQuotaId === null ? null : await db.db.query.desktopQuotas
      .findFirst({ where: (row, { eq: eqOp }) => eqOp(row.id, user.desktopQuotaId!) }) ?? null;

    const template = await pickTemplate(db, quota);
    const spec = resolveVmSpec(
      { template, quota },
      `${desktopNamePrefix}${user.username}`,
    );

    // 静态 IP 方案（Q6 默认）：没有配置网段就不分配，交给 VM 起来后由 Agent 回读
    const ip = desktopSubnet === '' ? null : await allocateIp(db, desktopSubnet);

    const [instance] = await db.db.insert(deskInstances).values({
      userId: user.id,
      templateId: template.id,
      quotaId: quota?.id ?? null,
      specVcpu: spec.vcpu,
      specMemoryMb: spec.memoryMb,
      status: 'new',
    }).returning();

    await db.commit();
    return { instance: instance!, spec: { ...spec, staticIp: ip?.ipAddress }, ipId: ip?.id ?? null };
  });

  const task = await enqueueTask({
    taskKey: `create:instance:${created.instance.id}`,
    type: 'create',
    instanceId: created.instance.id,
    userId: user.id,
    // 只放非敏感参数：静态 IP、规格、模板。**密码绝不能进 request_json**
    requestJson: {
      templateId: created.instance.templateId,
      vcpu: created.spec.vcpu,
      memoryMb: created.spec.memoryMb,
      ...(created.spec.staticIp === undefined ? {} : { staticIp: created.spec.staticIp }),
      ...(created.ipId === null ? {} : { ipAllocationId: created.ipId }),
    },
  });

  return {
    mode: 'vm',
    instanceId: created.instance.id,
    status: created.instance.status,
    created: true,
    taskId: task.id,
    vmIp: created.spec.staticIp ?? null,
  };
};

/**
 * 把 Guacamole 连接指向某台 VM，并在 `guac_connection_map` 留痕。
 *
 * 跨库（guacamole_db 与业务库）无法用同一个事务，因此顺序固定为
 * 「先写 guacamole，再写映射表」：映射表写失败只会导致下次重复同步（幂等），
 * 反过来则会留下「映射说已同步、guacamole 其实没改」的错账。
 */
export const syncGuacForInstance = async (
  userId: number,
  instanceId: number,
  username: string,
  target: { readonly hostname: string; readonly port?: number },
): Promise<number | null> => {
  if (!guacSyncEnabled()) return null;

  const ids = await ensureUserConnectionDetail(username, target);
  if (ids === null) return null;

  const paramsHash = hashParameters(buildRdpParameters(username, null, target));
  await withSession(async (db) => {
    // 同一 guacamole 连接可能被上一个已销毁的实例占用（一人一连接，回收后复用）。
    // 不先清理就会撞 `uq_guac_map_conn`，表现是「重建桌面时 500」。
    await db.db.delete(guacConnectionMap)
      .where(and(
        eq(guacConnectionMap.guacConnectionId, ids.connectionId),
        sql`${guacConnectionMap.instanceId} <> ${instanceId}`,
      ));

    await db.db.insert(guacConnectionMap).values({
      instanceId,
      userId,
      guacConnectionId: ids.connectionId,
      guacEntityId: ids.entityId,
      connectionName: `${getSettings().guacConnectionPrefix}${username}`,
      targetHost: target.hostname,
      targetPort: target.port ?? 3389,
      paramsHash,
      readGranted: true,
      syncedAt: new Date(),
    }).onConflictDoUpdate({
      target: guacConnectionMap.instanceId,
      set: {
        guacConnectionId: ids.connectionId,
        guacEntityId: ids.entityId,
        targetHost: target.hostname,
        targetPort: target.port ?? 3389,
        paramsHash,
        syncedAt: new Date(),
      },
    });
    await db.commit();
  });

  return ids.connectionId;
};

export type SyncAccountReason =
  | 'no_instance'
  | 'vm_not_ready'
  | 'vm_offline'
  | 'wake_timeout'
  | 'ssh_failed'
  | 'no_user';

export interface SyncAccountResult {
  readonly ok: boolean;
  /** ok=false 时的原因；调用方据此决定「阻断改密」还是「记日志 + 待补偿」 */
  readonly reason: SyncAccountReason | null;
  readonly host: string | null;
}

/**
 * 把明文密码同步进用户 VM 里的 Windows 本地账号（方案 A′ 的第四端）。
 *
 * ⚠️ 只能在**拿得到明文**的时刻调用（注册 / 改密）—— 平台只存哈希，
 * 之后无论如何都补不回来。
 *
 * 与 v2.2 相比多了一步「唤醒」：用户改密时桌面很可能处于挂起/关机（空闲 7 天
 * 就会挂起）。旧实现直接返回 `vm_offline`，于是密码永远补不进去，
 * 用户再登录就落到 `awaiting_account`、再改一次密码还是离线 —— 死循环。
 * 现在会先 `start` 再等它 running（预算 `desktopAccountSyncTimeoutMs`），
 * 唤醒代价是 A15 的两个副作用（时钟漂移、SMB 重连），但比「密码永久对不上」划算。
 */
export const syncVmAccount = async (
  userId: number,
  password: string,
  options: { readonly wake?: boolean } = {},
): Promise<SyncAccountResult> => {
  const active = await findActiveInstance(userId);
  if (!active) return { ok: false, reason: 'no_instance', host: null };

  const { instance, vm } = active;
  if (!vm) return { ok: false, reason: 'vm_not_ready', host: null };

  let host = vm.primaryIp;
  const provider = getDesktopProvider();

  if (vm.powerState !== 'running') {
    if (options.wake !== true || provider === null) {
      return { ok: false, reason: 'vm_offline', host };
    }
    const run = await ensureVmRunning(
      provider, vm.providerRef, getSettings().desktopAccountSyncTimeoutMs,
    );
    if (!run.ok) {
      return { ok: false, reason: run.reason === 'timeout' ? 'wake_timeout' : 'vm_offline', host };
    }
    const inspected = await provider.inspect(vm.providerRef).catch(() => null);
    host = inspected?.primaryIp ?? host;

    await withSession(async (db) => {
      await db.db.update(desktopVms).set({
        powerState: 'running',
        ...(host === null ? {} : { primaryIp: host }),
        agentReady: inspected?.agentReady ?? vm.agentReady,
        lastProbeAt: new Date(),
      }).where(eq(desktopVms.id, vm.id));
      await db.commit();
    });
  }

  if (host === null) return { ok: false, reason: 'vm_not_ready', host: null };

  const [user] = await withSession(async (db) => {
    const rows = await db.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows;
  });
  if (!user) return { ok: false, reason: 'no_user', host };

  // 动态导入：windows-account 会连带 ssh2，DMS 关闭时不必付出加载成本
  const { syncWindowsUser } = await import('../integrations/windows-account.js');
  try {
    // workspace=false：VM 上绝不建 SMB 共享与 NTFS ACL，那是文件服务器的职责
    await syncWindowsUser(user.username, password, { host, workspace: false });
  } catch (error) {
    console.warn('[desktop] VM 账号同步失败 user=%s host=%s: %s', user.username, host, error);
    return { ok: false, reason: 'ssh_failed', host };
  }

  await withSession(async (db) => {
    await db.db.update(deskInstances)
      .set({
        accountSyncedAt: new Date(),
        passwordVersion: user.passwordVersion,
        ...(instance.status === 'awaiting_account' ? { status: 'ready' as DeskInstanceStatus } : {}),
      })
      .where(eq(deskInstances.id, instance.id));
    await db.commit();
  });

  return { ok: true, reason: null, host };
};

/** 同一用户的同步串行化：连续改两次密码时不并发 SSH（后一次会覆盖前一次） */
const pendingSyncs = new Map<number, Promise<SyncAccountResult>>();

/** VM 里的账号是否已经是最新密码（不需要再跑一次 SSH） */
const isAccountCurrent = async (userId: number): Promise<boolean> =>
  withSession(async (db) => {
    const [row] = await db.db.select({
      accountSyncedAt: deskInstances.accountSyncedAt,
      syncedVersion: deskInstances.passwordVersion,
      userVersion: users.passwordVersion,
    }).from(deskInstances)
      .innerJoin(users, eq(users.id, deskInstances.userId))
      .where(and(
        eq(deskInstances.userId, userId),
        inArray(deskInstances.status, ACTIVE_STATUSES),
      ))
      .orderBy(desc(deskInstances.createdAt))
      .limit(1);

    if (!row) return false;
    return row.accountSyncedAt !== null && (row.syncedVersion ?? 0) >= row.userVersion;
  });

/**
 * 改密 / 登录后的**非阻断**同步入口 —— 调用方 `void` 掉即可，绝不 await。
 *
 * 为什么非阻断：现有 `/auth/change-password` 的语义是「三端全成功才改平台密码」，
 * 但 VM 端做不到这个保证（VM 可能离线、唤醒要一分钟）。若把它纳入同一条链，
 * VM 一挂用户就改不了密码 —— 那是把可用性问题放大成账号安全问题。
 *
 * 为什么登录也要调：登录接口同样握有明文密码，这是**唯一能自动补上 A16 缺口**的
 * 时刻。用户注册后首次登录 → 若桌面已建好但账号还没初始化，这里顺手补上，
 * 用户不必经历「先改一次密码」的困惑；反之若同步成功过（版本一致）就跳过，
 * 不重复跑 SSH。
 */
export const notifyVmPasswordChange = (userId: number, password: string): Promise<SyncAccountResult> => {
  const previous = pendingSyncs.get(userId) ?? Promise.resolve(null as unknown as SyncAccountResult);
  const next = previous
    .catch(() => null)
    .then(async () => (
      (await isAccountCurrent(userId))
        ? { ok: true, reason: null, host: null } as SyncAccountResult
        : syncVmAccount(userId, password, { wake: true })
    ))
    .catch((error: unknown) => {
      console.warn('[desktop] VM 账号同步异常 user=%s: %s', userId, error);
      return { ok: false, reason: 'ssh_failed', host: null } as SyncAccountResult;
    })
    .then((result) => {
      pendingSyncs.delete(userId);
      if (!result.ok) {
        console.warn('[desktop] VM 账号同步未完成 user=%s reason=%s host=%s',
          userId, result.reason, result.host);
      }
      return result;
    });

  pendingSyncs.set(userId, next);
  return next;
};

/** 回收：释放 IP 并解绑（供 recycle 任务使用） */
export const releaseIpAllocation = async (allocationId: number): Promise<void> => {
  await withSession(async (db) => {
    await db.db.update(desktopIpAllocations)
      .set({ state: 'free', vmId: null, releasedAt: new Date() })
      .where(eq(desktopIpAllocations.id, allocationId));
    await db.commit();
  });
};

/** 池水位：Provider 水位 + IPAM 剩余（方案 5.4 分配前置校验的输入） */
export const poolStatus = async (): Promise<{
  readonly freeIpCount: number;
  readonly cpuUsage: number | null;
  readonly memUsage: number | null;
}> =>
  withSession(async (db) => {
    const result = await db.db.execute(sql`
      SELECT count(*) FILTER (WHERE state = 'free')::int AS free_ip
      FROM desktop_ip_allocations
    `);
    const rows = (result as unknown as { rows: readonly { free_ip: number }[] }).rows ?? [];
    const provider = getDesktopProvider();
    const capacity = provider === null ? null : await provider.capacity().catch(() => null);
    return {
      freeIpCount: rows[0]?.free_ip ?? 0,
      cpuUsage: capacity?.cpuUsage ?? null,
      memUsage: capacity?.memUsage ?? null,
    };
  });
