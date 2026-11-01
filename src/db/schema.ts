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
  bigint, boolean, index, integer, jsonb, pgTable, serial, text,
  timestamp, uniqueIndex, varchar,
} from 'drizzle-orm/pg-core';
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
