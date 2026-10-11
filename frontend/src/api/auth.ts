import request from './request'
import type { TokenResponse, User } from '@/types'

export function login(username: string, password: string) {
  return request.post<unknown, TokenResponse>('/auth/login', { username, password })
}

export function register(username: string, password: string, display_name?: string) {
  return request.post<unknown, { id: number; username: string; role: string; message: string }>(
    '/auth/register',
    { username, password, display_name },
  )
}

export function getMe() {
  return request.get<unknown, User>('/auth/me')
}
