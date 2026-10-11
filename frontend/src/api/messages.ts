import request from './request'
import type { Message, DataApply } from '@/types'

export function getMessages() {
  return request.get<unknown, Message[]>('/messages')
}

export function markMessageRead(id: number) {
  return request.post<unknown, Message>(`/messages/${id}/read`)
}

export function markAllRead() {
  return request.post<unknown, { count: number }>('/messages/read-all')
}

// ---- 用户端数据申请 ----
export function submitApply(payload: {
  purpose: string
  fields: string[]
  time_range?: [string, string]
  priority: 'low' | 'medium' | 'high'
}) {
  return request.post<unknown, DataApply>('/user/data-applies', payload)
}

export function getMyApplies() {
  return request.get<unknown, DataApply[]>('/user/data-applies')
}
