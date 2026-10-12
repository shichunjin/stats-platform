<template>
  <el-container class="layout">
    <el-aside :width="collapsed ? '64px' : '220px'" class="sider">
      <div class="logo">
        <span v-if="!collapsed">数据分析托管平台</span>
        <span v-else>数</span>
      </div>
      <el-menu
        :default-active="activeMenu"
        :collapse="collapsed"
        :collapse-transition="false"
        router
        background-color="#001529"
        text-color="#bfcbd9"
        active-text-color="#409eff"
      >
        <template v-for="item in menuList" :key="item.path">
          <el-menu-item :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <template #title>{{ item.title }}</template>
          </el-menu-item>
        </template>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <div class="left">
          <el-icon class="collapse-btn" @click="collapsed = !collapsed">
            <Fold v-if="!collapsed" />
            <Expand v-else />
          </el-icon>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item>{{ currentTitle }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>
        <div class="right">
          <el-popover placement="bottom-end" :width="320" trigger="click">
            <template #reference>
              <el-badge :value="messageStore.unreadCount" :hidden="messageStore.unreadCount === 0" class="bell">
                <el-icon :size="20"><Bell /></el-icon>
              </el-badge>
            </template>
            <div class="msg-pop">
              <div class="msg-header">
                <span>消息通知</span>
                <el-button link type="primary" @click="readAll">全部已读</el-button>
              </div>
              <el-scrollbar max-height="300px">
                <div
                  v-for="m in messageStore.list"
                  :key="m.id"
                  class="msg-item"
                  :class="{ unread: !m.read }"
                  @click="onMsgClick(m)"
                >
                  <div class="msg-title">{{ m.title }}</div>
                  <div class="msg-content">{{ m.content }}</div>
                </div>
                <el-empty v-if="!messageStore.list.length" description="暂无消息" :image-size="60" />
              </el-scrollbar>
            </div>
          </el-popover>

          <el-tooltip content="全屏">
            <el-icon class="icon-btn" @click="toggleFullscreen"><FullScreen /></el-icon>
          </el-tooltip>

          <el-dropdown @command="onCommand">
            <span class="user-info">
              <el-avatar :size="30">{{ userStore.user?.display_name?.[0] || userStore.user?.username?.[0] }}</el-avatar>
              <span class="username">{{ userStore.user?.display_name || userStore.user?.username }}</span>
              <el-tag :type="userStore.isAdmin ? 'danger' : 'info'" size="small" style="margin-left: 6px">
                {{ userStore.isAdmin ? '管理员' : '用户' }}
              </el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <TabsView />

      <el-main class="main">
        <router-view v-slot="{ Component }">
          <keep-alive :include="tabsStore.cached">
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { useTabsStore } from '@/stores/tabs'
import { useMessageStore } from '@/stores/messages'
import type { Message } from '@/types'
import TabsView from './TabsView.vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const tabsStore = useTabsStore()
const messageStore = useMessageStore()

const collapsed = ref(false)
const activeMenu = computed(() => route.path)
const currentTitle = computed(() => (route.meta?.title as string) || '首页')

// 根据角色过滤菜单
// 约束：管理员端导航只允许出现 6 个菜单项，不得新增其他菜单
const menuList = computed(() => {
  const adminMenu = [
    { path: '/admin/pending-data', title: '待处理数据申请', icon: 'List' },
    { path: '/admin/data-filter', title: '数据筛选与生成', icon: 'Filter' },
    { path: '/admin/pending-exports', title: '待审核导出申请', icon: 'Checked' },
    { path: '/admin/user-scopes', title: '用户数据权限', icon: 'UserFilled' },
    { path: '/admin/platform-config', title: '连接数据分析PC', icon: 'Connection' },
    { path: '/admin/audit', title: '审计日志', icon: 'DocumentCopy' },
  ]
  const userMenu = [
    { path: '/user/data-request', title: '申请获取数据', icon: 'Download' },
    { path: '/user/my-requests', title: '我的申请记录', icon: 'Document' },
    { path: '/user/my-results', title: '我的结果文件', icon: 'FolderOpened' },
    { path: '/user/messages', title: '消息中心', icon: 'Bell' },
  ]
  return userStore.isAdmin ? adminMenu : userMenu
})

onMounted(() => {
  messageStore.fetch().catch(() => {})
})

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    userStore.logout()
    router.push('/login')
  }
}

function onMsgClick(m: Message) {
  if (!m.read) messageStore.read(m.id)
  if (m.link) router.push(m.link)
}

function readAll() {
  messageStore.readAll()
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen()
  else document.exitFullscreen()
}
</script>

<style scoped>
.layout { height: 100vh; }
.sider { background: #001529; transition: width 0.2s; overflow: hidden; }
.logo {
  height: 60px; display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 16px; font-weight: 600; letter-spacing: 1px;
  border-bottom: 1px solid #1f2d3d;
}
.sider :deep(.el-menu) { border-right: none; }

.header {
  background: #fff; display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid #e6e6e6; padding: 0 20px; height: 60px;
}
.left { display: flex; align-items: center; gap: 16px; }
.collapse-btn { font-size: 20px; cursor: pointer; color: #666; }
.right { display: flex; align-items: center; gap: 18px; }
.icon-btn { font-size: 20px; cursor: pointer; color: #666; }
.bell { cursor: pointer; }
.user-info { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.username { font-size: 14px; }

.main { background: #f0f2f5; padding: 16px; }

.msg-pop .msg-header { display: flex; justify-content: space-between; margin-bottom: 8px; font-weight: 600; }
.msg-item { padding: 8px 4px; border-bottom: 1px solid #f0f0f0; cursor: pointer; }
.msg-item.unread { background: #ecf5ff; }
.msg-title { font-size: 13px; font-weight: 500; }
.msg-content { font-size: 12px; color: #999; margin-top: 2px; }
</style>
