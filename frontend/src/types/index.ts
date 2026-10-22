// ============================================================
// 全局类型定义
// ============================================================

// ---- 通用 ----
export interface ApiResp<T = unknown> {
  code?: number
  data: T
  message?: string
}

export type UserRole = 'admin' | 'user' | 'superadmin'

// ---- 认证 / 用户 ----
export interface User {
  id: number
  username: string
  display_name?: string | null
  role: UserRole
  dept?: Scope | null
  scopes: Scope[]
}

export interface TokenResponse {
  access_token: string
  token_type: string
}

// ---- 数据范围 ----
export interface Scope {
  id: number
  scope_code: string
  scope_type: 'dept' | 'project'
  scope_name: string
  data_path: string
}

// ---- 会话 ----
export interface SessionInfo {
  id: number
  status: 'active' | 'ended'
  guac_url?: string | null
  launched_at?: string | null
}

// ---- 结果文件 ----
export interface PendingFile {
  id: number
  file_name: string
  file_type?: string | null
  status: 'pending' | 'approved' | 'rejected'
  review_reason?: string | null
  created_at?: string | null
}

export interface ExportResult {
  id: number
  result_name: string
  file_size?: number | null
  download_count: number
  expires_at?: string | null
  created_at?: string | null
}

// ---- 审计 ----
export interface AuditLog {
  id: number
  user_id?: number | null
  action: string
  detail?: string | null
  ip_addr?: string | null
  status?: 'success' | 'failed' | string
  created_at?: string | null
}

// ---- 数据申请（前端模型） ----
export type ApplyStatus = 'pending' | 'processing' | 'generating' | 'completed' | 'failed' | 'rejected'

export interface DataApply {
  id: number
  data_name: string
  purpose: string
  fields: string[]
  time_range?: [string, string]
  priority: 'low' | 'medium' | 'high'
  status: ApplyStatus
  reject_reason?: string
  apply_time: string
  finish_time?: string
  target_user_id?: number
  username?: string
  display_name?: string | null
}

// ---- 消息 ----
export interface Message {
  id: number
  title: string
  content: string
  type: 'info' | 'success' | 'warning'
  read: boolean
  created_at: string
  link?: string
}

// ---- 数据列（用于智能筛选控件渲染） ----
export type ColumnControlType = 'select' | 'range' | 'daterange' | 'input'

export interface DataColumn {
  name: string
  type: 'int' | 'float' | 'text' | 'date'
  control: ColumnControlType
  options?: string[] | number[]
  min?: number
  max?: number
}

// ---- 平台连接配置 ----
export interface PlatformConfig {
  host: string
  port: number
  username: string
  password: string
  workspace_dir: string
  output_path: string
}
