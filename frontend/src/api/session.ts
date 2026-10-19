import request from './request'
import type { SessionInfo } from '@/types'

export function connectSession() {
  return request.post<unknown, SessionInfo>('/session/connect')
}
