/**
 * ORM 模型 —— app/models.py（Drizzle pg-core）
 *
 * 本文件是**数据库结构的唯一真源**：
 *  - schema.sql 已废弃（含 ORM 中不存在的 scopes / dataset_meta / dataset_rows）
 *  - main.py 启动时的裸 SQL 幂等迁移（加列、建部分唯一索引）已全部下沉到这里
 *  - 生产变更一律走 drizzle-kit generate 产出版本化 SQL
 *
 * 所有 timestamp 保持 `timestamp WITHOUT time zone`，与 Python 侧
 * `Column(DateTime, default=datetime.utcnow)` 一致，避免存量数据被时区解释偏移。
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, index, integer, jsonb, numeric, pgTable, serial,
  text, timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { FilterMap } from '../schemas/filters.js';

/* 枚举：只做 TS 层约束，不动 DDL（不用 pgEnum，避免改造存量 varchar 列） */
export type UserRole = 'user' | 'admin' | 'superadmin';
export type SessionStatus = 'pending' | 'active' | 'ended';
export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type ApplyStatus =
  | 'pending' | 'processing' | 'generating' | 'completed' | 'failed' | 'rejected';
export type ApplyPriority = 'low' | 'medium' | 'high';
export type AuditStatus = 'success' | 'failed';
export type MessageType = 'info' | 'success' | 'warning';

/* 云桌面（多 VM）枚举 —— docs/multi-vm-desktop-plan.md 第 5/7 章 */
export type DesktopMode = 'rds' | 'vm';
export type DesktopProviderKind = 'proxmox' | 'libvirt' | 'vmware' | 'hyperv' | 'ecs';
export type TemplateStatus = 'active' | 'disabled' | 'building' | 'error';
export type DesktopVmPowerState = 'unknown' | 'running' | 'stopped' | 'suspended';
export type DeskInstanceStatus =
  | 'new' | 'provisioning' | 'configuring' | 'booting' | 'probing'
  | 'ready' | 'connected' | 'idle' | 'suspended' | 'failed' | 'error' | 'destroyed';
export type DesktopTaskStatus =
  'pending' | 'running' | 'success' | 'failed' | 'error' | 'cancelled';
export type DesktopTaskType =
  | 'create' | 'start' | 'stop' | 'suspend' | 'reset' | 'destroy'
  | 'config' | 'register' | 'recycle' | 'rebuild' | 'probe';
export type DesktopIpState = 'free' | 'allocated' | 'reserved';

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: 'date', withTimezone: false });

const createdAt = () =>
  utcTimestamp('created_at').notNull().$defaultFn(() => new Date());

/** 对应 Python 的 onupdate=datetime.utcnow */
const updatedAt = () =>
  utcTimestamp('updated_at').notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

/* ---------------- 表定义（按外键依赖顺序） ---------------- */

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  adSid: varchar('ad_sid', { length: 128 }),
  displayName: varchar('display_name', { length: 128 }),
  role: varchar('role', { length: 16 }).$type<UserRole>().notNull().default('user'),
  isActive: boolean('is_active').notNull().default(true),
  /** 注册用户密码哈希（演示账号为空） */
  passwordHash: varchar('password_hash', { length: 256 }),
  /** 改密递增，用于 JWT 失效 */
  passwordVersion: integer('password_version').notNull().default(1),
  /* ---- 云桌面扩展（方案 7.1，纯 ADD COLUMN，随时可 DROP 回滚；默认 rds 不改变现有行为） ---- */
  /** 灰度核心：rds=走老共享桌面（现状），vm=走专属 VM */
  desktopMode: varchar('desktop_mode', { length: 16 }).$type<DesktopMode>().notNull().default('rds'),
  /** 个性化配额（null = 按角色默认配额）；前向引用，见下方 desktopQuotas */
  desktopQuotaId: integer('desktop_quota_id').references(
    (): AnyPgColumn => desktopQuotas.id, { onDelete: 'set null' },
  ),
  /** 桌面总开关（补 SEC-09 无账号停用能力的桌面侧缺口） */
  desktopEnabled: boolean('desktop_enabled').notNull().default(true),
  createdAt: createdAt(),
});

/** Python 类名 Session，TS 侧改名避免与「数据库会话」概念混淆 */
export const remoteSessions = pgTable('sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  winSessionId: varchar('win_session_id', { length: 128 }),
  guacIdentifier: varchar('guac_identifier', { length: 128 }),
  status: varchar('status', { length: 16 }).$type<SessionStatus>().notNull().default('pending'),
  launchedAt: utcTimestamp('launched_at').notNull().$defaultFn(() => new Date()),
  endedAt: utcTimestamp('ended_at'),
}, (table) => ({
  userIdx: index('ix_sessions_user_id').on(table.userId),
  statusIdx: index('ix_sessions_status').on(table.status),
}));

export const pendingFiles = pgTable('pending_files', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  sessionId: integer('session_id').references(() => remoteSessions.id),
  fileName: varchar('file_name', { length: 256 }).notNull(),
  filePath: varchar('file_path', { length: 512 }).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }),
  fileType: varchar('file_type', { length: 16 }),
  /** B9：申请时文件内容 SHA256，审核通过前复核，防「申请后改写文件」绕过审查 */
  contentSha: varchar('content_sha', { length: 64 }),
  status: varchar('status', { length: 16 }).$type<ReviewStatus>().notNull().default('pending'),
  reviewReason: text('review_reason'),
  reviewedAt: utcTimestamp('reviewed_at'),
  reviewedBy: integer('reviewed_by').references(() => users.id),
  createdAt: createdAt(),
}, (table) => ({
  userIdx: index('ix_pending_files_user_id').on(table.userId),
  statusIdx: index('ix_pending_files_status').on(table.status),

  /**
   * B9 并发兜底：同一用户同名同内容仅允许一条 pending/approved 申请。
   * 原实现藏在 main.py:48 的启动裸 SQL 里，现下沉到 schema —— 漏掉它
   * 会让 results.py 的重复申请防护静默失效。
   * rejected 不占用唯一位；存量 content_sha 为 NULL 的行互不相等。
   */
  activeIdx: uniqueIndex('ix_pending_files_active')
    .on(table.userId, table.fileName, table.contentSha)
    .where(sql`${table.status} in ('pending', 'approved')`),
}));

export const exportResults = pgTable('export_results', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  pendingFileId: integer('pending_file_id').references(() => pendingFiles.id),
  resultName: varchar('result_name', { length: 256 }).notNull(),
  filePath: varchar('file_path', { length: 512 }).notNull(),
  fileSize: bigint('file_size', { mode: 'number' }),
  downloadCount: integer('download_count').notNull().default(0),
  /** 有效期，过期不可下载（null = 永久有效） */
  expiresAt: utcTimestamp('expires_at'),
  createdAt: createdAt(),
}, (table) => ({
  userIdx: index('ix_export_results_user_id').on(table.userId),
  expiresIdx: index('ix_export_results_expires_at').on(table.expiresAt),
}));

export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  action: varchar('action', { length: 64 }).notNull(),
  detail: text('detail'),
  ipAddr: varchar('ip_addr', { length: 64 }),
  status: varchar('status', { length: 16 }).$type<AuditStatus>().notNull().default('success'),
  createdAt: createdAt(),
}, (table) => ({
  userIdx: index('ix_audit_logs_user_id').on(table.userId),
  createdIdx: index('ix_audit_logs_created_at').on(table.createdAt),
}));

export const dataApplies = pgTable('data_applies', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  dataName: varchar('data_name', { length: 128 }).notNull().default('testData'),
  purpose: text('purpose').notNull(),
  fields: jsonb('fields').$type<readonly string[]>(),
  filters: jsonb('filters').$type<FilterMap>(),
  timeStart: utcTimestamp('time_start'),
  timeEnd: utcTimestamp('time_end'),
  priority: varchar('priority', { length: 16 }).$type<ApplyPriority>().notNull().default('medium'),
  status: varchar('status', { length: 16 }).$type<ApplyStatus>().notNull().default('pending'),
  rejectReason: text('reject_reason'),
  processedBy: integer('processed_by').references(() => users.id),
  finishedAt: utcTimestamp('finished_at'),
  createdAt: createdAt(),
}, (table) => ({
  userIdx: index('ix_data_applies_user_id').on(table.userId),
  statusIdx: index('ix_data_applies_status').on(table.status),
}));

export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  title: varchar('title', { length: 256 }).notNull(),
  content: text('content'),
  msgType: varchar('msg_type', { length: 16 }).$type<MessageType>().notNull().default('info'),
  link: varchar('link', { length: 256 }),
  isRead: boolean('is_read').notNull().default(false),
  createdAt: createdAt(),
}, (table) => ({
  userReadIdx: index('ix_messages_user_id_read').on(table.userId, table.isRead),
}));

/** Guacamole 免密直连令牌（登录时换取，按用户缓存；不保存用户密码） */
export const guacAuthTokens = pgTable('guac_auth_tokens', {
  userId: integer('user_id').primaryKey().references(() => users.id),
  authToken: text('auth_token').notNull(),
  expiresAt: utcTimestamp('expires_at').notNull(),
  updatedAt: updatedAt(),
});

/** C4：管理端「连接数据分析PC」真正落库；密码永不落库 */
export const platformConfig = pgTable('platform_config', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: text('value'),
  updatedBy: integer('updated_by').references(() => users.id),
  updatedAt: updatedAt(),
});

/* ---------------- 云桌面（多 VM）—— docs/multi-vm-desktop-plan.md 第 7 章 ---------------- */

/** 模板：VM 的「源」。规格存**基线**，分档靠配额覆盖而非多建模板（方案 7.2 / A12）。 */
export const desktopTemplates = pgTable('desktop_templates', {
  id: serial('id').primaryKey(),
  /** 'win2022-stats-v3' */
  code: varchar('code', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 128 }).notNull(),
  osType: varchar('os_type', { length: 32 }).$type<string>().notNull().default('windows'),
  osVersion: varchar('os_version', { length: 64 }),
  provider: varchar('provider', { length: 32 }).$type<DesktopProviderKind>().notNull(),
  /** Proxmox 'node=pve1,vmid=9001' / ECS 'm-xxx' */
  providerRef: varchar('provider_ref', { length: 128 }).notNull(),
  providerNode: varchar('provider_node', { length: 64 }),
  /** 基线 vCPU（可被配额 default_vcpu 覆盖，方案 7.6） */
  vcpu: integer('vcpu').notNull(),
  /** 基线内存 MB（可被配额 default_memory_mb 覆盖） */
  memoryMb: integer('memory_mb').notNull(),
  /** 磁盘**下限**：只能扩不能缩，不进配额覆盖逻辑（A14） */
  diskGb: integer('disk_gb').notNull(),
  /** Proxmox 存储名 */
  storage: varchar('storage', { length: 64 }),
  networkBridge: varchar('network_bridge', { length: 32 }),
  /** 桌面网段 VLAN */
  vlanId: integer('vlan_id'),
  /** 模板内置账号（一般为 Administrator） */
  guestUsername: varchar('guest_username', { length: 64 }),
  /** 对应 software-registry.json 版本，支撑模板批量核对 */
  softwareRegistryVer: varchar('software_registry_ver', { length: 64 }),
  /** login.ps1 版本（便于批量核对） */
  loginScriptVer: varchar('login_script_ver', { length: 64 }),
  status: varchar('status', { length: 16 }).$type<TemplateStatus>().notNull().default('active'),
  /** 模板不可用时的兜底；部分唯一索引保证最多一个 */
  isDefault: boolean('is_default').notNull().default(false),
  /** 该模板最多承载实例数 */
  maxInstances: integer('max_instances'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => ({
  statusIdx: index('ix_desktop_templates_status').on(table.status),
  defaultIdx: uniqueIndex('uq_desktop_templates_default')
    .on(table.isDefault).where(sql`${table.isDefault} = true`),
}));

/** 配额：规格档位表（default_*）+ 上限（max_*）。方案 7.6，v2.1 A12。 */
export const desktopQuotas = pgTable('desktop_quotas', {
  id: serial('id').primaryKey(),
  /** 'default' | 'vip' | 'student' */
  code: varchar('code', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 128 }).notNull(),
  /** 该档默认 vCPU（null = 取模板基线；须 ≤ max_vcpu，写入时校验） */
  defaultVcpu: integer('default_vcpu'),
  /** 该档默认内存 MB（null = 取模板基线；须 ≤ max_memory_mb） */
  defaultMemoryMb: integer('default_memory_mb'),
  maxVcpu: integer('max_vcpu').notNull().default(8),
  maxMemoryMb: integer('max_memory_mb').notNull().default(16384),
  maxDiskGb: integer('max_disk_gb').notNull().default(200),
  /** 每用户可持有桌面数 */
  maxInstances: integer('max_instances').notNull().default(1),
  /** 每日最长使用时长（小时，null = 不限）。pg numeric 读出为 string，比较时用 Number() 收敛 */
  maxDailyHours: numeric('max_daily_hours', { precision: 6, scale: 2 }),
  /** 空闲挂起天数 */
  maxIdleDays: integer('max_idle_days').notNull().default(7),
  /** 强制重建天数（方案 DDL 草案名 max_life_days，落地按 7.6 注释改名） */
  rebuildAfterDays: integer('rebuild_after_days').notNull().default(180),
  /** 空闲销毁天数（方案 DDL 草案名 max_lifetime_days，落地改名） */
  destroyAfterIdleDays: integer('destroy_after_idle_days').notNull().default(30),
  allowRebuild: boolean('allow_rebuild').notNull().default(true),
  /** 该配额绑定模板（null = 用当前默认模板） */
  templateId: integer('template_id').references(() => desktopTemplates.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 桌面实例：业务视角的用户桌面（一人一活跃实例）。方案 7.4。 */
export const deskInstances = pgTable('desk_instances', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  templateId: integer('template_id').notNull().references(() => desktopTemplates.id, { onDelete: 'restrict' }),
  /** 当前承载 VM（null = 已解绑/回收中） */
  currentVmId: integer('current_vm_id').references(
    (): AnyPgColumn => desktopVms.id, { onDelete: 'set null' },
  ),
  quotaId: integer('quota_id').references(() => desktopQuotas.id, { onDelete: 'set null' }),
  /** 分配规格（v2.1 A12：quota.default_* ?? template.*，rebuild 时重算） */
  specVcpu: integer('spec_vcpu'),
  specMemoryMb: integer('spec_memory_mb'),
  status: varchar('status', { length: 16 }).$type<DeskInstanceStatus>().notNull().default('new'),
  lastError: text('last_error'),
  lastErrorAt: utcTimestamp('last_error_at'),
  provisionStartedAt: utcTimestamp('provision_started_at'),
  provisionFinishedAt: utcTimestamp('provision_finished_at'),
  lastConnectedAt: utcTimestamp('last_connected_at'),
  lastDisconnectedAt: utcTimestamp('last_disconnected_at'),
  connectCount: integer('connect_count').notNull().default(0),
  rebuildCount: integer('rebuild_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => ({
  /** 一人仅一个「活跃」桌面（并发冲突第一道防线）；error/destroyed 不占位，可重新分配 */
  activeUserIdx: uniqueIndex('uq_desk_instances_active_user')
    .on(table.userId)
    .where(sql`${table.status} in ('new','provisioning','configuring','booting','probing','ready','connected','idle','suspended','failed')`),
  statusIdx: index('ix_desk_instances_status').on(table.status),
  idleIdx: index('ix_desk_instances_idle')
    .on(table.lastDisconnectedAt)
    .where(sql`${table.status} in ('idle','suspended')`),
  updatedIdx: index('ix_desk_instances_updated_at').on(table.updatedAt),
}));

/** 虚拟机：Provider 侧实体。规格列是**实际值快照**（与 desk_instances.spec_* 在 rebuild 后分离，两者都保留）。方案 7.3。 */
export const desktopVms = pgTable('desktop_vms', {
  id: serial('id').primaryKey(),
  /** null = 已与用户解绑（回收中） */
  instanceId: integer('instance_id').references(
    (): AnyPgColumn => deskInstances.id, { onDelete: 'set null' },
  ),
  templateId: integer('template_id').notNull().references(() => desktopTemplates.id, { onDelete: 'restrict' }),
  provider: varchar('provider', { length: 32 }).$type<DesktopProviderKind>().notNull(),
  /** Proxmox vmid（如 '9101'）/ ECS instanceId */
  providerRef: varchar('provider_ref', { length: 128 }).notNull(),
  providerNode: varchar('provider_node', { length: 64 }),
  /** 'DESK-alice' */
  name: varchar('name', { length: 128 }).notNull(),
  primaryIp: varchar('primary_ip', { length: 64 }),
  macAddress: varchar('mac_address', { length: 32 }),
  rdpPort: integer('rdp_port').notNull().default(3389),
  sshPort: integer('ssh_port').notNull().default(22),
  protocol: varchar('protocol', { length: 16 }).notNull().default('rdp'),
  powerState: varchar('power_state', { length: 16 }).$type<DesktopVmPowerState>().notNull().default('unknown'),
  /** 快照创建时实际规格（null = 尚未克隆完成） */
  vcpu: integer('vcpu'),
  memoryMb: integer('memory_mb'),
  diskGb: integer('disk_gb'),
  agentReady: boolean('agent_ready').notNull().default(false),
  lastProbeAt: utcTimestamp('last_probe_at'),
  /** 支撑自愈（连续 N 次失败 → 自动 reset/重建） */
  probeFailCount: integer('probe_fail_count').notNull().default(0),
  /** 回收前快照 */
  snapshotRef: varchar('snapshot_ref', { length: 128 }),
  createdAt: createdAt(),
  startedAt: utcTimestamp('started_at'),
  stoppedAt: utcTimestamp('stopped_at'),
  destroyedAt: utcTimestamp('destroyed_at'),
}, (table) => ({
  instanceIdx: index('ix_desktop_vms_instance').on(table.instanceId),
  /** Provider 侧 ref 复用冲突防护（已销毁的 ref 可被新 VM 复用） */
  refIdx: uniqueIndex('uq_desktop_vms_ref')
    .on(table.provider, table.providerRef)
    .where(sql`${table.destroyedAt} is null`),
  ipIdx: index('ix_desktop_vms_ip')
    .on(table.primaryIp).where(sql`${table.destroyedAt} is null`),
  powerIdx: index('ix_desktop_vms_power_state').on(table.powerState),
}));

/** Guacamole 连接映射：跨库引用（guacamole_* 在另一个 database），不加 FK，一致性靠 DMS reconcile。方案 7.5。 */
export const guacConnectionMap = pgTable('guac_connection_map', {
  id: serial('id').primaryKey(),
  instanceId: integer('instance_id').notNull().references(() => deskInstances.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** guacamole_connection.connection_id */
  guacConnectionId: integer('guac_connection_id').notNull(),
  /** guacamole_entity.entity_id */
  guacEntityId: integer('guac_entity_id').notNull(),
  /** 'windows-alice' */
  connectionName: varchar('connection_name', { length: 192 }).notNull(),
  /** 当前写入的 hostname（= VM IP） */
  targetHost: varchar('target_host', { length: 128 }).notNull(),
  targetPort: integer('target_port').notNull().default(3389),
  /** 参数指纹，判断是否需重新同步（避免每次 connect 全量重写） */
  paramsHash: varchar('params_hash', { length: 64 }),
  readGranted: boolean('read_granted').notNull().default(false),
  /** 回收时撤销授权的时间 */
  revokedAt: utcTimestamp('revoked_at'),
  syncedAt: utcTimestamp('synced_at'),
  createdAt: createdAt(),
}, (table) => ({
  instanceIdx: uniqueIndex('uq_guac_map_instance').on(table.instanceId),
  connIdx: uniqueIndex('uq_guac_map_conn').on(table.guacConnectionId),
  userIdx: index('ix_guac_map_user').on(table.userId),
}));

/** 任务执行记录：PostgreSQL `FOR UPDATE SKIP LOCKED` 队列的持久化载体（worker 重启安全）。方案 7.8。 */
export const desktopTasks = pgTable('desktop_tasks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  /** 幂等键：'ensure:user:42:2026-11-02' */
  taskKey: varchar('task_key', { length: 128 }).notNull().unique(),
  type: varchar('type', { length: 32 }).$type<DesktopTaskType>().notNull(),
  instanceId: integer('instance_id').references(() => deskInstances.id, { onDelete: 'set null' }),
  vmId: integer('vm_id').references(() => desktopVms.id, { onDelete: 'set null' }),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  status: varchar('status', { length: 16 }).$type<DesktopTaskStatus>().notNull().default('pending'),
  /** 'clone' | 'boot' | 'config' | 'probe' | 'register'（展示用，不穷举校验） */
  stage: varchar('stage', { length: 32 }),
  progress: integer('progress').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  /** 指数退避起点（重试时间） */
  notBefore: utcTimestamp('not_before').notNull().$defaultFn(() => new Date()),
  /** Proxmox UPID / ECS RequestId */
  providerTask: varchar('provider_task', { length: 128 }),
  /** 入参摘要（脱敏，禁存密码） */
  requestJson: jsonb('request_json'),
  errorCode: varchar('error_code', { length: 64 }),
  /** 截断到 2000 字符 */
  errorMessage: text('error_message'),
  startedAt: utcTimestamp('started_at'),
  finishedAt: utcTimestamp('finished_at'),
  createdAt: createdAt(),
}, (table) => ({
  /** 队列扫描索引：worker 只看 pending 且到期的任务 */
  queueIdx: index('ix_desktop_tasks_queue')
    .on(table.status, table.notBefore)
    .where(sql`${table.status} = 'pending'`),
  instanceIdx: index('ix_desktop_tasks_instance').on(table.instanceId, table.createdAt),
}));

/** IPAM（静态 IP 方案，开机即可连无需等 Agent）。方案 7.9。 */
export const desktopIpAllocations = pgTable('desktop_ip_allocations', {
  id: serial('id').primaryKey(),
  /** '10.20.0.0/16' */
  subnet: varchar('subnet', { length: 64 }).notNull(),
  ipAddress: varchar('ip_address', { length: 64 }).notNull(),
  vlanId: integer('vlan_id'),
  vmId: integer('vm_id').references(() => desktopVms.id, { onDelete: 'set null' }),
  state: varchar('state', { length: 16 }).$type<DesktopIpState>().notNull().default('free'),
  allocatedAt: utcTimestamp('allocated_at'),
  releasedAt: utcTimestamp('released_at'),
}, (table) => ({
  ipIdx: uniqueIndex('uq_desktop_ip').on(table.subnet, table.ipAddress),
  stateIdx: index('ix_desktop_ip_state').on(table.subnet, table.state),
}));

/* ---------------- 关系（必须在所有表定义之后） ---------------- */

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(remoteSessions),
  ownedPendingFiles: many(pendingFiles, { relationName: 'pending_file_owner' }),
  reviewedPendingFiles: many(pendingFiles, { relationName: 'pending_file_reviewer' }),
  exportResults: many(exportResults),
  auditLogs: many(auditLogs),
  ownedApplies: many(dataApplies, { relationName: 'data_apply_owner' }),
  processedApplies: many(dataApplies, { relationName: 'data_apply_processor' }),
  messages: many(messages),
  configEdits: many(platformConfig),
  deskInstances: many(deskInstances),
  guacConnections: many(guacConnectionMap),
  desktopTasks: many(desktopTasks),
}));

export const remoteSessionsRelations = relations(remoteSessions, ({ one, many }) => ({
  user: one(users, { fields: [remoteSessions.userId], references: [users.id] }),
  pendingFiles: many(pendingFiles),
}));

export const pendingFilesRelations = relations(pendingFiles, ({ one }) => ({
  user: one(users, {
    fields: [pendingFiles.userId], references: [users.id], relationName: 'pending_file_owner',
  }),
  reviewer: one(users, {
    fields: [pendingFiles.reviewedBy], references: [users.id], relationName: 'pending_file_reviewer',
  }),
  session: one(remoteSessions, {
    fields: [pendingFiles.sessionId], references: [remoteSessions.id],
  }),
}));

export const exportResultsRelations = relations(exportResults, ({ one }) => ({
  user: one(users, { fields: [exportResults.userId], references: [users.id] }),
  pendingFile: one(pendingFiles, {
    fields: [exportResults.pendingFileId], references: [pendingFiles.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  user: one(users, { fields: [auditLogs.userId], references: [users.id] }),
}));

export const dataAppliesRelations = relations(dataApplies, ({ one }) => ({
  user: one(users, {
    fields: [dataApplies.userId], references: [users.id], relationName: 'data_apply_owner',
  }),
  processor: one(users, {
    fields: [dataApplies.processedBy], references: [users.id], relationName: 'data_apply_processor',
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  user: one(users, { fields: [messages.userId], references: [users.id] }),
}));

export const guacAuthTokensRelations = relations(guacAuthTokens, ({ one }) => ({
  user: one(users, { fields: [guacAuthTokens.userId], references: [users.id] }),
}));

export const platformConfigRelations = relations(platformConfig, ({ one }) => ({
  editor: one(users, { fields: [platformConfig.updatedBy], references: [users.id] }),
}));

/* ---- 云桌面（多 VM）关系 ---- */

export const desktopTemplatesRelations = relations(desktopTemplates, ({ many }) => ({
  quotas: many(desktopQuotas),
  instances: many(deskInstances),
  vms: many(desktopVms),
}));

export const desktopQuotasRelations = relations(desktopQuotas, ({ one, many }) => ({
  template: one(desktopTemplates, {
    fields: [desktopQuotas.templateId], references: [desktopTemplates.id],
  }),
  instances: many(deskInstances),
}));

export const deskInstancesRelations = relations(deskInstances, ({ one, many }) => ({
  user: one(users, { fields: [deskInstances.userId], references: [users.id] }),
  template: one(desktopTemplates, {
    fields: [deskInstances.templateId], references: [desktopTemplates.id],
  }),
  quota: one(desktopQuotas, { fields: [deskInstances.quotaId], references: [desktopQuotas.id] }),
  currentVm: one(desktopVms, {
    fields: [deskInstances.currentVmId], references: [desktopVms.id],
  }),
  vms: many(desktopVms),
  guacConnection: one(guacConnectionMap, {
    fields: [deskInstances.id], references: [guacConnectionMap.instanceId],
  }),
  tasks: many(desktopTasks),
}));

export const desktopVmsRelations = relations(desktopVms, ({ one, many }) => ({
  instance: one(deskInstances, {
    fields: [desktopVms.instanceId], references: [deskInstances.id],
  }),
  template: one(desktopTemplates, {
    fields: [desktopVms.templateId], references: [desktopTemplates.id],
  }),
  tasks: many(desktopTasks),
  ipAllocations: many(desktopIpAllocations),
}));

export const guacConnectionMapRelations = relations(guacConnectionMap, ({ one }) => ({
  instance: one(deskInstances, {
    fields: [guacConnectionMap.instanceId], references: [deskInstances.id],
  }),
  user: one(users, { fields: [guacConnectionMap.userId], references: [users.id] }),
}));

export const desktopTasksRelations = relations(desktopTasks, ({ one }) => ({
  instance: one(deskInstances, {
    fields: [desktopTasks.instanceId], references: [deskInstances.id],
  }),
  vm: one(desktopVms, { fields: [desktopTasks.vmId], references: [desktopVms.id] }),
  user: one(users, { fields: [desktopTasks.userId], references: [users.id] }),
}));

export const desktopIpAllocationsRelations = relations(desktopIpAllocations, ({ one }) => ({
  vm: one(desktopVms, {
    fields: [desktopIpAllocations.vmId], references: [desktopVms.id],
  }),
}));

/* ---------------- 行类型 ---------------- */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RemoteSession = typeof remoteSessions.$inferSelect;
export type PendingFile = typeof pendingFiles.$inferSelect;
export type NewPendingFile = typeof pendingFiles.$inferInsert;
export type ExportResult = typeof exportResults.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type DataApply = typeof dataApplies.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type GuacAuthToken = typeof guacAuthTokens.$inferSelect;
export type PlatformConfigRow = typeof platformConfig.$inferSelect;

/* 云桌面（多 VM）行类型 */
export type DesktopTemplate = typeof desktopTemplates.$inferSelect;
export type NewDesktopTemplate = typeof desktopTemplates.$inferInsert;
export type DesktopQuota = typeof desktopQuotas.$inferSelect;
export type NewDesktopQuota = typeof desktopQuotas.$inferInsert;
export type DeskInstance = typeof deskInstances.$inferSelect;
export type NewDeskInstance = typeof deskInstances.$inferInsert;
export type DesktopVm = typeof desktopVms.$inferSelect;
export type NewDesktopVm = typeof desktopVms.$inferInsert;
export type GuacConnectionMapRow = typeof guacConnectionMap.$inferSelect;
export type NewGuacConnectionMapRow = typeof guacConnectionMap.$inferInsert;
export type DesktopTask = typeof desktopTasks.$inferSelect;
export type NewDesktopTask = typeof desktopTasks.$inferInsert;
export type DesktopIpAllocation = typeof desktopIpAllocations.$inferSelect;
export type NewDesktopIpAllocation = typeof desktopIpAllocations.$inferInsert;
