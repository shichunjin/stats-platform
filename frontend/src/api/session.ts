import request from './request'
import type { SessionInfo } from '@/types'

export function connectSession(software: string) {
  return request.post<unknown, SessionInfo>('/session/connect', { software })
}
