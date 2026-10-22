import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '@/types'
import { getMe, login as apiLogin } from '@/api/auth'

export const useUserStore = defineStore('user', () => {
  const token = ref<string>(localStorage.getItem('access_token') || '')
  const user = ref<User | null>(null)

  const isLoggedIn = computed(() => !!token.value)
  // 超级管理员天然拥有全部管理员页面
  const isAdmin = computed(() => user.value?.role === 'admin' || user.value?.role === 'superadmin')
  const isSuperAdmin = computed(() => user.value?.role === 'superadmin')

  async function login(username: string, password: string) {
    const res = await apiLogin(username, password)
    token.value = res.access_token
    localStorage.setItem('access_token', res.access_token)
    await fetchUser()
  }

  async function fetchUser() {
    user.value = await getMe()
  }

  function logout() {
    token.value = ''
    user.value = null
    localStorage.removeItem('access_token')
  }

  return { token, user, isLoggedIn, isAdmin, isSuperAdmin, login, fetchUser, logout }
})
