import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '@/types'
import { getMe, login as apiLogin } from '@/api/auth'
import { useTabsStore } from './tabs'

export const useUserStore = defineStore('user', () => {
  const token = ref<string>(localStorage.getItem('access_token') || '')
  const user = ref<User | null>(null)

  const isLoggedIn = computed(() => !!token.value)
  // 超级管理员天然拥有全部管理员页面
  const isAdmin = computed(() => user.value?.role === 'admin' || user.value?.role === 'superadmin')
  const isSuperAdmin = computed(() => user.value?.role === 'superadmin')

  async function login(username: string, password: string) {
    const res = await apiLogin(username, password)
    // 新用户登录前清空上一账号遗留的标签页与页面缓存
    useTabsStore().resetTabs()
    token.value = res.access_token
    localStorage.setItem('access_token', res.access_token)
    await fetchUser()
  }

  async function fetchUser() {
    user.value = await getMe()
  }

  function logout() {
    // 退出时清空标签页，避免残留到下一个登录的用户
    useTabsStore().resetTabs()
    token.value = ''
    user.value = null
    localStorage.removeItem('access_token')
  }

  return { token, user, isLoggedIn, isAdmin, isSuperAdmin, login, fetchUser, logout }
})
