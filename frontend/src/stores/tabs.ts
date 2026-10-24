import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RouteLocationNormalized } from 'vue-router'

export interface TabItem {
  path: string
  title: string
  name: string
  affix?: boolean
}

export const useTabsStore = defineStore('tabs', () => {
  const tabs = ref<TabItem[]>([{ path: '/dashboard', title: '首页', name: 'Dashboard', affix: true }])
  const active = ref('/dashboard')
  const cached = ref<string[]>(['Dashboard'])

  function addTab(route: RouteLocationNormalized) {
    if (route.meta?.hideTab) return
    const exists = tabs.value.find((t) => t.path === route.path)
    if (!exists) {
      tabs.value.push({
        path: route.path,
        title: (route.meta?.title as string) || route.name as string,
        name: route.name as string,
      })
      if (route.name) cached.value.push(route.name as string)
    }
    active.value = route.path
  }

  function removeTab(path: string) {
    const idx = tabs.value.findIndex((t) => t.path === path)
    if (idx === -1) return
    const tab = tabs.value[idx]
    if (tab.affix) return
    tabs.value.splice(idx, 1)
    cached.value = cached.value.filter((n) => n !== tab.name)
    // 如果关闭的是当前标签，跳到前一个
    if (active.value === path) {
      const next = tabs.value[idx - 1] || tabs.value[idx]
      active.value = next?.path || '/dashboard'
    }
  }

  function setActive(path: string) {
    active.value = path
  }

  // 退出登录/切换账号时调用：清空上一用户的标签页与缓存页面，
  // 防止上一个用户打开的标签残留到新用户的导航栏。
  function resetTabs() {
    tabs.value = [{ path: '/dashboard', title: '首页', name: 'Dashboard', affix: true }]
    active.value = '/dashboard'
    cached.value = ['Dashboard']
  }

  return { tabs, active, cached, addTab, removeTab, setActive, resetTabs }
})
