import request from './request'
import type { AuditLog, PendingFile, User, DataApply } from '@/types'

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

// ---- 用户角色管理（仅超级管理员） ----
export function getManageUsers() {
  return request.get<unknown, User[]>('/admin/manage/users')
}

export function updateUserRole(userId: number, role: 'user' | 'admin') {
  return request.put<unknown, User>(`/admin/manage/users/${userId}/role`, { role })
}

// 重置用户密码（仅超级管理员）：同步更新 Windows 云桌面与 Guacamole
export function resetUserPassword(userId: number, newPassword: string) {
  return request.post<unknown, { message: string }>(
    `/admin/manage/users/${userId}/reset-password`,
    { new_password: newPassword },
  )
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

// ---- 平台连接配置（安全修复 C4：保存落库，密码不传输/不落库） ----
export interface PlatformConfig {
  host: string
  port: number
  username: string
  workspace_dir: string
  output_path: string
}

export function getPlatformConfig() {
  return request.get<unknown, PlatformConfig>('/admin/platform-config')
}

export function savePlatformConfig(payload: PlatformConfig) {
  return request.put<unknown, { success: boolean; message: string }>('/admin/platform-config', payload)
}
