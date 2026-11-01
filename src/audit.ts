/**
 * 审计日志写入 —— 对应各处 `db.add(AuditLog(...))`
 * 收敛成单一函数，避免 20 处散落的字段拼写漂移。
 */
import type { DbSession } from './db/session.js';
import { auditLogs, type AuditStatus } from './db/schema.js';

export interface AuditEntry {
  readonly userId: number | null;
  readonly action: string;
  readonly detail?: string | null;
  readonly ipAddr?: string | null;
  readonly status?: AuditStatus;
}

export const recordAudit = (db: DbSession, entry: AuditEntry): Promise<unknown> =>
  db.db.insert(auditLogs).values({
    userId: entry.userId,
    action: entry.action,
    detail: entry.detail ?? null,
    ipAddr: entry.ipAddr ?? null,
    status: entry.status ?? 'success',
  });
