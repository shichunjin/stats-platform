import request from './request'
import type { AuditLog, PendingFile, User, Scope, DataApply } from '@/types'

export function getAuditLog(limit = 100) {
  return request.get<unknown, AuditLog[]>('/admin/audit', { params: { limit } })
}

export function getPendingExports() {
  return request.get<unknown, PendingFile[]>('/admin/pending')
}

export function approveExport(id: number, reason?: string) {
  return request.post<unknown, PendingFile>(`/admin/pending/${id}/approve`, { reason })
}

export function rejectExport(id: number, reason?: string) {
  return request.post<unknown, PendingFile>(`/admin/pending/${id}/reject`, { reason })
}

export function getUsers() {
  return request.get<unknown, User[]>('/admin/users')
}

export function getScopes() {
  return request.get<unknown, Scope[]>('/admin/scopes')
}

export function updateUserScopes(userId: number, dept_id: number | null, scope_ids: number[]) {
  return request.put<unknown, User>(`/admin/users/${userId}/scopes`, { dept_id, scope_ids })
}

// ---- 数据申请（前端模型，对应 mock） ----
export function getDataApplies(status?: string) {
  return request.get<unknown, DataApply[]>('/admin/data-applies', { params: { status } })
}

export function rejectDataApply(id: number, reason: string) {
  return request.post<unknown, DataApply>(`/admin/data-applies/${id}/reject`, { reason })
}

// 申请进入处理中（批量通过时逐条调用）
export function processDataApply(id: number) {
  return request.post<unknown, DataApply>(`/admin/data-applies/${id}/process`)
}

// ---- 数据分析PC连接 ----
export interface PlatformTestResult {
  success: boolean
  message: string
  latency_ms?: number
}

export function testPlatform(payload: {
  host: string
  port: number
  username: string
  password: string
}) {
  return request.post<unknown, PlatformTestResult>('/admin/platform/test', payload)
}
