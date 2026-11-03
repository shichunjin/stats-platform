/**
 * API 请求/响应 Schema —— app/schemas.py
 *
 * ⚠️ 关键约定：**wire 层（JSON 键名）必须与 Python 完全一致，即 snake_case。**
 * pydantic 默认按字段名序列化，现有 Vue 前端依赖 display_name / access_token /
 * time_range / target_user_id 等 snake_case 键名。改成 camelCase 会直接打断前端。
 *
 * 因此本文件分两类：
 *  - wire schema：键名 snake_case，同时用于运行时校验与 OpenAPI
 *  - mapper 函数：把 Drizzle 行（camelCase）转成 wire 形状（snake_case）
 *
 * TS 业务代码内部一律 camelCase，边界转换只发生在 mapper 里。
 */
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import type {
  AuditLog, DataApply, DeskInstance, DesktopQuota, DesktopTask, DesktopTemplate, DesktopVm,
  ExportResult, Message, PendingFile, RemoteSession, User,
} from '../db/schema.js';
import { filterMapOutSchema, filterMapSchema } from './filters.js';

extendZodWithOpenApi(z);

/* ================================================================
 * 公共片段
 * ================================================================ */

const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .openapi({ description: 'ISO 8601 时间字符串', example: '2026-11-01T06:48:00.000Z' });

/** [起始时间, 结束时间]，两端都可为 null。仅用于**入向**校验 */
export const timeRangeSchema = z
  .tuple([isoDateTimeSchema.nullable(), isoDateTimeSchema.nullable()])
  .openapi({ description: '[起始时间, 结束时间] ISO 字符串' });

/**
 * 出向的 time_range：用 `array` 而不是 `tuple`。
 *
 * fast-json-stringify 的元组分支要求 `items[i]` 有**顶层 type**（见其 buildArrayTypeCondition），
 * 而带 `format: date-time` 的 nullable 字符串会被 zod-to-json-schema 展开成
 * `anyOf`（没有顶层 type），结果是「只要申请填了时间范围，序列化就必抛
 * Item at 0 does not match schema definition」。改成 array 后走的是逐元素 buildValue，正常。
 */
export const timeRangeOutSchema = z
  .array(isoDateTimeSchema.nullable())
  .openapi({ description: '[起始时间, 结束时间] ISO 字符串，两端可为 null' });

const ROLE_DESCRIPTION = '角色：user=普通用户 / admin=管理员 / superadmin=超级管理员';

/* ================================================================
 * Auth
 * ================================================================ */

export const loginRequestSchema = z.object({
  username: z.string().min(1).openapi({ description: '用户名', example: 'admin' }),
  password: z.string().min(1).openapi({ description: '密码', example: 'admin123' }),
}).strict();

/** 用户名同时作为 Windows 本地账号名，遵循 Windows 命名规则 */
export const registerRequestSchema = z.object({
  username: z
    .string().min(3).max(20)
    .regex(/^[A-Za-z0-9._-]+$/, '仅允许字母、数字与 . _ -')
    .openapi({ description: '用户名（3-20 位，将作为 Windows 登录账号）', example: 'newuser' }),
  password: z
    .string().min(8).max(64)
    .openapi({ description: '密码（8-64 字符，四类字符至少三类，不含用户名）', example: 'Newuser@2026' }),
  display_name: z
    .string().max(128).nullish()
    .openapi({ description: '显示名称（可选）', example: '张三' }),
}).strict();

export const changePasswordRequestSchema = z.object({
  old_password: z.string().min(1).openapi({ description: '原密码' }),
  new_password: z.string().min(8).max(64).openapi({
    description: '新密码（8-64 字符，四类字符至少三类，不含用户名）', example: 'Newuser@2027',
  }),
}).strict();

/** 统一的「只回一条消息」响应体 */
export const messageResponseSchema = z.object({
  message: z.string().openapi({ description: '结果说明' }),
});

export const tokenResponseSchema = z.object({
  access_token: z.string().openapi({ description: 'JWT 访问令牌' }),
  token_type: z.string().default('bearer').openapi({ description: '令牌类型' }),
});

export const registerResponseSchema = z.object({
  id: z.number().int().openapi({ description: '新用户 ID' }),
  username: z.string().openapi({ description: '用户名' }),
  display_name: z.string().nullable().openapi({ description: '显示名称' }),
  role: z.string().openapi({ description: '角色（新注册用户固定为 user）' }),
  message: z.string().openapi({ description: '提示信息' }),
});

/* ================================================================
 * User / Session / Audit
 * ================================================================ */

export const userOutSchema = z.object({
  id: z.number().int().openapi({ description: '用户 ID' }),
  username: z.string().openapi({ description: '用户名' }),
  display_name: z.string().nullable().openapi({ description: '显示名称' }),
  role: z.string().openapi({ description: ROLE_DESCRIPTION }),
});

export const userAdminOutSchema = userOutSchema.extend({
  is_active: z.boolean().openapi({ description: '账号是否启用' }),
  created_at: isoDateTimeSchema.nullable().openapi({ description: '注册时间' }),
});

export const sessionOutSchema = z.object({
  id: z.number().int().openapi({ description: '会话 ID' }),
  status: z.string().openapi({ description: '会话状态：active=活跃 / ended=已结束' }),
  guac_url: z.string().nullable().openapi({ description: 'Guacamole 浏览器访问 URL' }),
  launched_at: isoDateTimeSchema.nullable().openapi({ description: '会话启动时间' }),
});

export const auditLogOutSchema = z.object({
  id: z.number().int().openapi({ description: '日志 ID' }),
  user_id: z.number().int().nullable().openapi({ description: '操作者用户 ID' }),
  action: z.string().openapi({ description: '操作类型（如 login/session_launch/result_approved）' }),
  detail: z.string().nullable().openapi({ description: '操作详情' }),
  ip_addr: z.string().nullable().openapi({ description: '来源 IP' }),
  status: z.string().default('success').openapi({ description: '结果状态：success / failed' }),
  created_at: isoDateTimeSchema.nullable().openapi({ description: '操作时间' }),
});

/* ================================================================
 * 结果 / 审核
 * ================================================================ */

export const pendingFileOutSchema = z.object({
  id: z.number().int().openapi({ description: '文件记录 ID' }),
  file_name: z.string().openapi({ description: '文件名' }),
  file_type: z.string().nullable().openapi({ description: '文件扩展名（如 csv/png）' }),
  status: z.string().openapi({ description: '审查状态：pending=待审 / approved=通过 / rejected=拒绝' }),
  review_reason: z.string().nullable().openapi({ description: '审查结论/拒绝原因' }),
  created_at: isoDateTimeSchema.nullable().openapi({ description: '记录创建时间' }),
});

export const exportResultOutSchema = z.object({
  id: z.number().int().openapi({ description: '结果 ID' }),
  result_name: z.string().openapi({ description: '结果文件名' }),
  file_size: z.number().int().nullable().openapi({ description: '文件大小（字节）' }),
  download_count: z.number().int().default(0).openapi({ description: '累计下载次数' }),
  expires_at: isoDateTimeSchema.nullable().openapi({ description: '有效期，过期不可下载（null=永久）' }),
  created_at: isoDateTimeSchema.nullable().openapi({ description: '发布时间' }),
});

export const exportReviewRequestSchema = z.object({
  reason: z.string().nullish().openapi({ description: '审核意见（拒绝时建议填写原因）' }),
}).strict();

/* ================================================================
 * 消息中心（字段重命名：msg_type -> type，is_read -> read）
 * ================================================================ */

export const messageOutSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  content: z.string().nullable(),
  type: z.string().default('info').openapi({ description: '类型：info/success/warning' }),
  read: z.boolean().default(false).openapi({ description: '是否已读' }),
  link: z.string().nullable().openapi({ description: '点击跳转路径' }),
  created_at: isoDateTimeSchema.nullable(),
});

/* ================================================================
 * 数据申请 / 筛选生成
 * ================================================================ */

export const dataApplyCreateSchema = z.object({
  purpose: z.string().min(1).openapi({ description: '数据用途' }),
  fields: z.array(z.string().min(1).max(128)).max(200).default([]).openapi({ description: '所需字段' }),
  time_range: timeRangeSchema.nullish(),
  /**
   * 刻意**不**用 z.enum：Python 侧是裸 `str`，非法值在路由里回落 'medium' 而不是 422。
   * 改成枚举会让既有客户端（比如传空串）从「能用」变成 422，属于破坏性收紧。
   */
  priority: z.string().default('medium')
    .openapi({ description: '优先级：low/medium/high（其他值回落 medium）' }),
  filters: filterMapSchema.default({}).openapi({ description: '筛选条件：列名 -> 值/[min,max]/模糊文本' }),
}).strict();

export const dataApplyOutSchema = z.object({
  id: z.number().int(),
  data_name: z.string(),
  purpose: z.string(),
  fields: z.array(z.string()).default([]),
  // 出向用宽 schema：库里可能存着 Python 时代写入的任意 JSON，序列化器不匹配会抛 500
  filters: filterMapOutSchema.default({}),
  time_range: timeRangeOutSchema.nullable(),
  priority: z.string(),
  status: z.string(),
  reject_reason: z.string().nullable(),
  apply_time: isoDateTimeSchema.nullable(),
  finish_time: isoDateTimeSchema.nullable(),
  target_user_id: z.number().int(),
});

export const dataApplyRejectRequestSchema = z.object({
  reason: z.string().min(1).openapi({ description: '驳回原因' }),
}).strict();

export const filteredDataGenerateRequestSchema = z.object({
  filters: filterMapSchema.default({}).openapi({ description: '筛选条件：列名 -> 值/[min,max]/模糊文本' }),
  target_user_id: z.number().int().positive().openapi({ description: '接收数据的目标用户 ID' }),
  filename: z
    .string().min(1).max(255)
    // 路径穿越防护：文件名不允许分隔符与 ..（Python 侧仅写在 description，无校验）
    .regex(/^[^/\\:*?"<>|]+$/, '文件名含非法字符')
    .refine((name) => !name.includes('..'), '文件名不允许 ..')
    .nullish()
    .openapi({ description: '目标文件名（含扩展名），留空自动命名' }),
  /** SEC-01：前端 Number(applyId) 空值会得到 0，Python 侧 0 会走进必崩分支 */
  apply_id: z
    .number().int().nonnegative().nullish()
    .transform((value) => (value === 0 ? null : value ?? null))
    .openapi({ description: '关联的数据申请 ID（可选，生成后自动置为完成）' }),
}).strict();

/**
 * ⚠️ type / control 刻意保持 `z.string()`（对齐 Python 的裸 str）。
 *
 * dataset.ts 实际会产出 `type='date'` / `control='daterange'`（日期列），
 * 而 Fastify 序列化器对不匹配 schema 的值是**运行时抛 TypeError**——写成枚举
 * 会让「表里存在日期列」直接变成 /data/columns 全量 500。
 */
export const dataColumnOutSchema = z.object({
  name: z.string().openapi({ description: '列名' }),
  type: z.string().openapi({ description: '数据类型：int/float/text/date' }),
  control: z.string().openapi({ description: '筛选控件：select/range/input/daterange' }),
  options: z.array(z.unknown()).nullish().openapi({ description: '枚举值（control=select 时）' }),
  // 日期列的 min/max 是 'YYYY-MM-DD' 字符串，不是数字，所以这里也不能收窄成 number
  min: z.unknown().nullish().openapi({ description: '最小值（数字或日期字符串）' }),
  max: z.unknown().nullish().openapi({ description: '最大值（数字或日期字符串）' }),
});

/* ================================================================
 * Mapper：Drizzle 行（camelCase） -> wire 形状（snake_case）
 * 替代 pydantic 的 from_attributes=True
 * ================================================================ */

const toIso = (value: Date | null): string | null => value?.toISOString() ?? null;

export const toUserOut = (row: User): z.infer<typeof userOutSchema> => ({
  id: row.id,
  username: row.username,
  display_name: row.displayName ?? null,
  role: row.role,
});

export const toUserAdminOut = (row: User): z.infer<typeof userAdminOutSchema> => ({
  ...toUserOut(row),
  is_active: row.isActive,
  created_at: toIso(row.createdAt),
});

/** guac_url 不在 ORM 上，由路由层计算后传入 */
export const toSessionOut = (
  row: RemoteSession,
  guacUrl: string | null,
): z.infer<typeof sessionOutSchema> => ({
  id: row.id,
  status: row.status,
  guac_url: guacUrl,
  launched_at: toIso(row.launchedAt),
});

export const toPendingFileOut = (row: PendingFile): z.infer<typeof pendingFileOutSchema> => ({
  id: row.id,
  file_name: row.fileName,
  file_type: row.fileType ?? null,
  status: row.status,
  review_reason: row.reviewReason ?? null,
  created_at: toIso(row.createdAt),
});

export const toExportResultOut = (row: ExportResult): z.infer<typeof exportResultOutSchema> => ({
  id: row.id,
  result_name: row.resultName,
  file_size: row.fileSize ?? null,
  download_count: row.downloadCount,
  expires_at: toIso(row.expiresAt),
  created_at: toIso(row.createdAt),
});

export const toAuditLogOut = (row: AuditLog): z.infer<typeof auditLogOutSchema> => ({
  id: row.id,
  user_id: row.userId ?? null,
  action: row.action,
  detail: row.detail ?? null,
  ip_addr: row.ipAddr ?? null,
  status: row.status,
  created_at: toIso(row.createdAt),
});

/** 字段重命名：msg_type -> type，is_read -> read */
export const toMessageOut = (row: Message): z.infer<typeof messageOutSchema> => ({
  id: row.id,
  title: row.title,
  content: row.content ?? null,
  type: row.msgType,
  read: row.isRead,
  link: row.link ?? null,
  created_at: toIso(row.createdAt),
});

export const toDataApplyOut = (row: DataApply): z.infer<typeof dataApplyOutSchema> => ({
  id: row.id,
  data_name: row.dataName,
  purpose: row.purpose,
  // 列为 readonly（DB 侧不希望调用方就地改数组），序列化时拷一份可变副本
  fields: [...(row.fields ?? [])],
  filters: (row.filters ?? {}),
  time_range: row.timeStart === null && row.timeEnd === null
    ? null
    : [toIso(row.timeStart), toIso(row.timeEnd)],
  priority: row.priority,
  status: row.status,
  reject_reason: row.rejectReason ?? null,
  apply_time: toIso(row.createdAt),
  finish_time: toIso(row.finishedAt),
  target_user_id: row.userId,
});

/* ================================================================
 * 云桌面（多 VM）—— docs/multi-vm-desktop-plan.md 6.6
 * ================================================================ */

export const desktopEnsureOutSchema = z.object({
  /** rds = 走共享桌面（灰度未开启/未配置）；vm = 专属虚拟机 */
  mode: z.enum(['rds', 'vm']).openapi({ description: '桌面模式：rds=共享桌面 / vm=专属虚拟机' }),
  instance_id: z.number().int().nullable().openapi({ description: '桌面实例 ID；rds 模式为 null' }),
  status: z.string().nullable().openapi({
    description: '实例状态：new/provisioning/booting/ready/awaiting_account/failed…；'
      + 'awaiting_account = VM 已就绪但还没同步 Windows 账号，需改一次密码',
  }),
  /** 前端据此决定按钮文案与是否可跳转 */
  ready: z.boolean().openapi({ description: '是否已可连接（ready/awaiting_account）' }),
  created: z.boolean().openapi({ description: '本次调用是否新建了实例（false = 命中已有实例）' }),
  task_id: z.number().int().nullable().openapi({ description: '入队的任务 ID；-1 表示未重复入队' }),
  vm_ip: z.string().nullable().openapi({ description: '桌面 VM 的 IP（未分配时为 null）' }),
});

/** 状态 → 前端可用性。awaiting_account 也算「可连」但要在 UI 上提示改密 */
const isConnectableStatus = (status: string | null): boolean =>
  status === 'ready' || status === 'awaiting_account';

export const toDesktopEnsureOut = (outcome: {
  readonly mode: 'rds' | 'vm';
  readonly instanceId: number | null;
  readonly status: string | null;
  readonly created: boolean;
  readonly taskId: number | null;
  readonly vmIp: string | null;
}): z.infer<typeof desktopEnsureOutSchema> => ({
  mode: outcome.mode,
  instance_id: outcome.instanceId,
  status: outcome.status,
  ready: isConnectableStatus(outcome.status),
  created: outcome.created,
  task_id: outcome.taskId,
  vm_ip: outcome.vmIp,
});

/* ================================================================
 * 云桌面：管理端（/admin/desktops/*）—— docs/multi-vm-desktop-plan.md 6.6
 *
 * 一律**扁平**输出（不嵌套对象）：出向 schema 由 fast-json-stringify 序列化，
 * 嵌套对象里任何一个字段与 schema 不符都会让整个端点 500；扁平字段少一层出错概率。
 * ================================================================ */

/** 任务列表项（运维排查用：看得到 attempts / error_message / 下次重试时间） */
export const desktopTaskOutSchema = z.object({
  id: z.number().int().openapi({ description: '任务 ID' }),
  task_key: z.string().openapi({ description: '幂等键（重复入队会命中它）' }),
  type: z.string().openapi({ description: 'create/start/probe/suspend/recycle…' }),
  status: z.string().openapi({ description: 'pending/running/success/failed/error/cancelled' }),
  stage: z.string().nullable().openapi({ description: '阶段（clone/boot/probe…，仅展示用）' }),
  progress: z.number().int().openapi({ description: '进度 0-100' }),
  attempts: z.number().int().openapi({ description: '已尝试次数' }),
  max_attempts: z.number().int().openapi({ description: '最大尝试次数，达到即 failed' }),
  instance_id: z.number().int().nullable(),
  user_id: z.number().int().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable().openapi({ description: '失败原因（已截断到 2000 字符）' }),
  not_before: isoDateTimeSchema.nullable().openapi({ description: '最早可执行时间（退避到期点）' }),
  created_at: isoDateTimeSchema.nullable(),
  started_at: isoDateTimeSchema.nullable(),
  finished_at: isoDateTimeSchema.nullable(),
});

/** 实例列表项：把 user/vm/template/quota/最近任务 折叠成一行，管理端一次拿全 */
export const desktopAdminOutSchema = z.object({
  id: z.number().int().openapi({ description: '桌面实例 ID' }),
  user_id: z.number().int(),
  username: z.string(),
  desktop_mode: z.string().openapi({ description: '用户级灰度开关：rds / vm' }),
  desktop_enabled: z.boolean().openapi({ description: '用户级启用标记' }),
  status: z.string().openapi({ description: '实例状态（见 DeskInstanceStatus）' }),
  spec_vcpu: z.number().int().nullable().openapi({ description: '分配规格（模板基线或配额覆盖）' }),
  spec_memory_mb: z.number().int().nullable(),
  account_synced_at: isoDateTimeSchema.nullable()
    .openapi({ description: 'Windows 账号同步时间；null + status=awaiting_account 表示还没初始化' }),
  vm_id: z.number().int().nullable(),
  vm_name: z.string().nullable(),
  vm_ip: z.string().nullable(),
  vm_created_at: isoDateTimeSchema.nullable()
    .openapi({ description: '当前 VM 的创建时间（reaper 的重建计时基准）' }),
  template_drift: z.boolean().openapi({
    description: '模板在本 VM 创建后被更新过 —— 这台机器可能还跑着旧 login.ps1/旧软件清单（近似信号，精确核对需读 VM 上的 template-manifest.json）',
  }),
  provider_ref: z.string().nullable().openapi({ description: '<node>/<vmid>' }),
  provider_node: z.string().nullable(),
  power_state: z.string().nullable().openapi({ description: 'running/stopped/suspended/unknown' }),
  agent_ready: z.boolean().nullable(),
  rdp_port: z.number().int().nullable(),
  template_code: z.string().nullable(),
  quota_code: z.string().nullable(),
  connect_count: z.number().int(),
  rebuild_count: z.number().int(),
  last_connected_at: isoDateTimeSchema.nullable(),
  last_disconnected_at: isoDateTimeSchema.nullable(),
  last_error: z.string().nullable(),
  last_error_at: isoDateTimeSchema.nullable(),
  created_at: isoDateTimeSchema.nullable(),
  updated_at: isoDateTimeSchema.nullable(),
  task_id: z.number().int().nullable().openapi({ description: '该实例最近一条任务 ID' }),
  task_type: z.string().nullable(),
  task_status: z.string().nullable(),
  task_stage: z.string().nullable(),
  task_progress: z.number().int().nullable(),
  task_error: z.string().nullable(),
});

/** 管理端动作（挂起/回收/探活/重试）的统一回执 */
export const desktopActionOutSchema = z.object({
  message: z.string(),
  task_id: z.number().int().nullable().openapi({ description: '入队的任务 ID；null = 未产生任务' }),
  created: z.boolean().openapi({ description: 'false = 同一分钟内的重复操作，命中幂等键未重复入队' }),
});

export const desktopTemplateOutSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  os_type: z.string(),
  os_version: z.string().nullable(),
  provider: z.string(),
  provider_ref: z.string(),
  provider_node: z.string().nullable(),
  vcpu: z.number().int().openapi({ description: '基线 vCPU（可被配额 default_vcpu 覆盖）' }),
  memory_mb: z.number().int(),
  disk_gb: z.number().int().openapi({ description: '磁盘下限（只能扩不能缩）' }),
  storage: z.string().nullable(),
  network_bridge: z.string().nullable(),
  vlan_id: z.number().int().nullable(),
  guest_username: z.string().nullable(),
  software_registry_ver: z.string().nullable(),
  login_script_ver: z.string().nullable().openapi({ description: '对应 VM 上 template-manifest.json' }),
  status: z.string(),
  is_default: z.boolean(),
  max_instances: z.number().int().nullable(),
  created_at: isoDateTimeSchema.nullable(),
  updated_at: isoDateTimeSchema.nullable(),
});

export const desktopQuotaOutSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  name: z.string(),
  default_vcpu: z.number().int().nullable().openapi({ description: 'null = 取模板基线' }),
  default_memory_mb: z.number().int().nullable(),
  max_vcpu: z.number().int(),
  max_memory_mb: z.number().int(),
  max_disk_gb: z.number().int(),
  max_instances: z.number().int(),
  max_daily_hours: z.number().nullable().openapi({ description: '每日最长使用时长；null = 不限' }),
  max_idle_days: z.number().int().openapi({ description: '空闲挂起天数' }),
  rebuild_after_days: z.number().int(),
  destroy_after_idle_days: z.number().int().openapi({ description: '空闲销毁天数' }),
  allow_rebuild: z.boolean(),
  template_id: z.number().int().nullable(),
  created_at: isoDateTimeSchema.nullable(),
  updated_at: isoDateTimeSchema.nullable(),
});

export const toDesktopTaskOut = (row: DesktopTask): z.infer<typeof desktopTaskOutSchema> => ({
  id: row.id,
  task_key: row.taskKey,
  type: row.type,
  status: row.status,
  stage: row.stage ?? null,
  progress: row.progress,
  attempts: row.attempts,
  max_attempts: row.maxAttempts,
  instance_id: row.instanceId ?? null,
  user_id: row.userId ?? null,
  error_code: row.errorCode ?? null,
  error_message: row.errorMessage ?? null,
  not_before: toIso(row.notBefore),
  created_at: toIso(row.createdAt),
  started_at: toIso(row.startedAt),
  finished_at: toIso(row.finishedAt),
});

export const toDesktopAdminOut = (
  row: {
    readonly instance: DeskInstance;
    readonly username: string;
    readonly desktopMode: string;
    readonly desktopEnabled: boolean;
    readonly vm: DesktopVm | null;
    readonly templateCode: string | null;
    /** 模板最近更新时间：与 vm.createdAt 比对得出 template_drift */
    readonly templateUpdatedAt: Date | null;
    readonly quotaCode: string | null;
  },
  latestTask: DesktopTask | null,
): z.infer<typeof desktopAdminOutSchema> => {
  const { instance, vm } = row;
  return {
    id: instance.id,
    user_id: instance.userId,
    username: row.username,
    desktop_mode: row.desktopMode,
    desktop_enabled: row.desktopEnabled,
    status: instance.status,
    spec_vcpu: instance.specVcpu ?? null,
    spec_memory_mb: instance.specMemoryMb ?? null,
    account_synced_at: toIso(instance.accountSyncedAt),
    vm_id: vm?.id ?? null,
    vm_name: vm?.name ?? null,
    vm_ip: vm?.primaryIp ?? null,
    vm_created_at: vm === null ? null : toIso(vm.createdAt),
    // 近似漂移信号：模板改过（脚本/软件清单更新）而 VM 还是旧的。
    // 刻意不查 VM 上的 template-manifest.json —— probe 每分钟一次 SSH 不划算，
    // 且管理端的用途只是「圈出可能需要重建的机器」，误报成本低、漏报成本高。
    template_drift: vm !== null && row.templateUpdatedAt !== null
      && row.templateUpdatedAt > vm.createdAt,
    provider_ref: vm?.providerRef ?? null,
    provider_node: vm?.providerNode ?? null,
    power_state: vm?.powerState ?? null,
    agent_ready: vm?.agentReady ?? null,
    rdp_port: vm?.rdpPort ?? null,
    template_code: row.templateCode,
    quota_code: row.quotaCode,
    connect_count: instance.connectCount,
    rebuild_count: instance.rebuildCount,
    last_connected_at: toIso(instance.lastConnectedAt),
    last_disconnected_at: toIso(instance.lastDisconnectedAt),
    last_error: instance.lastError ?? null,
    last_error_at: toIso(instance.lastErrorAt),
    created_at: toIso(instance.createdAt),
    updated_at: toIso(instance.updatedAt),
    task_id: latestTask?.id ?? null,
    task_type: latestTask?.type ?? null,
    task_status: latestTask?.status ?? null,
    task_stage: latestTask?.stage ?? null,
    task_progress: latestTask?.progress ?? null,
    task_error: latestTask?.errorMessage ?? null,
  };
};

export const toDesktopTemplateOut = (
  row: DesktopTemplate,
): z.infer<typeof desktopTemplateOutSchema> => ({
  id: row.id,
  code: row.code,
  name: row.name,
  os_type: row.osType,
  os_version: row.osVersion ?? null,
  provider: row.provider,
  provider_ref: row.providerRef,
  provider_node: row.providerNode ?? null,
  vcpu: row.vcpu,
  memory_mb: row.memoryMb,
  disk_gb: row.diskGb,
  storage: row.storage ?? null,
  network_bridge: row.networkBridge ?? null,
  vlan_id: row.vlanId ?? null,
  guest_username: row.guestUsername ?? null,
  software_registry_ver: row.softwareRegistryVer ?? null,
  login_script_ver: row.loginScriptVer ?? null,
  status: row.status,
  is_default: row.isDefault,
  max_instances: row.maxInstances ?? null,
  created_at: toIso(row.createdAt),
  updated_at: toIso(row.updatedAt),
});

/**
 * ⚠️ `max_daily_hours` 是 pg `numeric`，drizzle 0.33 没有 mode 选项，读出来是 **string**。
 * 必须在这里 Number() 收敛：出向 schema 声明的是 number，直接把字符串交给
 * fast-json-stringify 会抛 TypeError → 整个端点 500（本项目踩过同类坑）。
 */
export const toDesktopQuotaOut = (
  row: DesktopQuota,
): z.infer<typeof desktopQuotaOutSchema> => ({
  id: row.id,
  code: row.code,
  name: row.name,
  default_vcpu: row.defaultVcpu ?? null,
  default_memory_mb: row.defaultMemoryMb ?? null,
  max_vcpu: row.maxVcpu,
  max_memory_mb: row.maxMemoryMb,
  max_disk_gb: row.maxDiskGb,
  max_instances: row.maxInstances,
  max_daily_hours: row.maxDailyHours === null ? null : Number(row.maxDailyHours),
  max_idle_days: row.maxIdleDays,
  rebuild_after_days: row.rebuildAfterDays,
  destroy_after_idle_days: row.destroyAfterIdleDays,
  allow_rebuild: row.allowRebuild,
  template_id: row.templateId ?? null,
  created_at: toIso(row.createdAt),
  updated_at: toIso(row.updatedAt),
});

/* ================================================================
 * wire 类型
 * ================================================================ */

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type DataApplyCreate = z.infer<typeof dataApplyCreateSchema>;
export type FilteredDataGenerateRequest = z.infer<typeof filteredDataGenerateRequestSchema>;
export type MessageOut = z.infer<typeof messageOutSchema>;
export type MessageResponse = z.infer<typeof messageResponseSchema>;
export type DataApplyOut = z.infer<typeof dataApplyOutSchema>;
export type DataColumnOut = z.infer<typeof dataColumnOutSchema>;
export type UserOut = z.infer<typeof userOutSchema>;
export type SessionOut = z.infer<typeof sessionOutSchema>;
export type RegisterResponse = z.infer<typeof registerResponseSchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type DesktopAdminOut = z.infer<typeof desktopAdminOutSchema>;
export type DesktopTaskOut = z.infer<typeof desktopTaskOutSchema>;
export type DesktopActionOut = z.infer<typeof desktopActionOutSchema>;
export type DesktopTemplateOut = z.infer<typeof desktopTemplateOutSchema>;
export type DesktopQuotaOut = z.infer<typeof desktopQuotaOutSchema>;
