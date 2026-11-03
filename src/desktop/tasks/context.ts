/**
 * 任务上下文加载 —— 四个生命周期任务（start / probe / suspend / recycle）共用的前置查询
 *
 * 放在一处的原因：这些任务都要「实例 + VM + 用户 + 模板 + 配额」五样东西，
 * 各自拼 SQL 很快会在字段选择与缺失处理上分叉（例如有的抛错、有的静默跳过）。
 */
import { eq } from 'drizzle-orm';
import {
  deskInstances, desktopTemplates, users,
  type DeskInstance, type DesktopQuota, type DesktopTemplate, type DesktopVm,
} from '../../db/schema.js';
import { withSession } from '../../db/session.js';
import { getDesktopProvider } from '../provider/proxmox.js';
import type { DesktopProvider } from '../provider/types.js';
import { DesktopError } from '../service.js';

/** 取 Provider：未配置时抛业务错误（而不是返回 null 让调用方各自处理） */
export const requireProvider = (): DesktopProvider => {
  const provider = getDesktopProvider();
  if (provider === null) {
    throw new DesktopError('NO_PROVIDER', '未配置 Proxmox（PROXMOX_API_URL / PROXMOX_TOKEN_ID），无法操作桌面');
  }
  return provider;
};

export interface TaskContext {
  readonly instance: DeskInstance;
  readonly vm: DesktopVm | null;
  readonly template: DesktopTemplate;
  readonly quota: DesktopQuota | null;
  readonly username: string;
  /** 用户当前密码版本：与 instance.passwordVersion 比较即知 VM 里的密码是否过期 */
  readonly userPasswordVersion: number;
  readonly userActive: boolean;
}

export const loadTaskContext = async (instanceId: number): Promise<TaskContext> =>
  withSession(async (db) => {
    const [instance] = await db.db.select().from(deskInstances)
      .where(eq(deskInstances.id, instanceId)).limit(1);
    if (!instance) throw new DesktopError('NO_INSTANCE', `桌面实例不存在: ${instanceId}`);

    const [user] = await db.db.select().from(users)
      .where(eq(users.id, instance.userId)).limit(1);
    if (!user) throw new DesktopError('NO_USER', `桌面所属用户不存在: ${instance.userId}`);

    const [template] = await db.db.select().from(desktopTemplates)
      .where(eq(desktopTemplates.id, instance.templateId)).limit(1);
    if (!template) throw new DesktopError('NO_TEMPLATE', `模板不存在: ${instance.templateId}`);

    const quota = instance.quotaId === null
      ? null
      : await db.db.query.desktopQuotas.findFirst({
        where: (row, { eq: eqOp }) => eqOp(row.id, instance.quotaId!),
      }) ?? null;

    const vm = instance.currentVmId === null
      ? null
      : await db.db.query.desktopVms.findFirst({
        where: (row, { eq: eqOp }) => eqOp(row.id, instance.currentVmId!),
      }) ?? null;

    return {
      instance,
      vm: vm ?? null,
      template,
      quota,
      username: user.username,
      userPasswordVersion: user.passwordVersion,
      userActive: user.isActive,
    };
  });

/**
 * VM 里的 Windows 账号是否已经是最新密码。
 *
 * 两个判据缺一不可：`accountSyncedAt` 为空 = 账号从没建过（A16 的 awaiting_account）；
 * `passwordVersion` 落后 = 账号存在但密码是旧的（改密时 VM 离线，方案 9.2）。
 */
export const isAccountStale = (
  instance: Pick<DeskInstance, 'accountSyncedAt' | 'passwordVersion'>,
  userPasswordVersion: number,
): boolean =>
  instance.accountSyncedAt === null || (instance.passwordVersion ?? 0) < userPasswordVersion;
