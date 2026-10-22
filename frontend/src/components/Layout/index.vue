<template>
  <el-container class="layout">
    <el-aside :width="collapsed ? '64px' : '220px'" class="sider">
      <div class="logo">
        <span class="logo-mark">
          <el-icon><DataLine /></el-icon>
        </span>
        <span v-if="!collapsed" class="logo-text">数据分析托管平台</span>
      </div>
      <el-menu
        :default-active="activeMenu"
        :collapse="collapsed"
        :collapse-transition="false"
        router
        background-color="#0b1220"
        text-color="rgba(255,255,255,0.72)"
        active-text-color="#ffffff"
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
                {{ userStore.isSuperAdmin ? '超级管理员' : userStore.isAdmin ? '管理员' : '用户' }}
              </el-tag>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="changePwd">修改密码</el-dropdown-item>
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

  <!-- 修改密码对话框：平台与 Guacamole 密码同步修改 -->
  <el-dialog v-model="pwdDialogVisible" title="修改密码" width="420px" :close-on-click-modal="false">
    <el-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-width="80px">
      <el-form-item label="原密码" prop="old_password">
        <el-input v-model="pwdForm.old_password" type="password" show-password autocomplete="off" />
      </el-form-item>
      <el-form-item label="新密码" prop="new_password">
        <el-input v-model="pwdForm.new_password" type="password" show-password autocomplete="off" />
      </el-form-item>
      <el-form-item label="确认密码" prop="confirm_password">
        <el-input v-model="pwdForm.confirm_password" type="password" show-password autocomplete="off" />
      </el-form-item>
    </el-form>
    <el-text type="info" size="small">新密码需 8-64 位，且包含大写字母、小写字母、数字、特殊符号中的至少三类，不能包含用户名。修改后，数据分析平台与 Windows 云桌面（Guacamole）登录密码将同步更新。</el-text>
    <template #footer>
      <el-button @click="pwdDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="pwdLoading" @click="submitChangePwd">确认修改</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { useTabsStore } from '@/stores/tabs'
import { useMessageStore } from '@/stores/messages'
import { changePassword } from '@/api/auth'
import { checkPasswordStrength } from '@/utils'
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
// 约束：admin 角色导航固定 6 个菜单项，不得新增；
// superadmin 在此基础上追加「用户管理」（角色分配，仅超管可见）
const menuList = computed(() => {
  const adminMenu = [
    { path: '/admin/pending-data', title: '待处理数据申请', icon: 'List' },
    { path: '/admin/data-filter', title: '数据筛选与生成', icon: 'Filter' },
    { path: '/admin/pending-exports', title: '待审核导出申请', icon: 'Checked' },
    { path: '/admin/user-scopes', title: '用户数据权限', icon: 'UserFilled' },
    { path: '/admin/platform-config', title: '连接数据分析PC', icon: 'Connection' },
    { path: '/admin/audit', title: '审计日志', icon: 'DocumentCopy' },
  ]
  const superOnlyMenu = [
    { path: '/admin/user-manage', title: '用户管理', icon: 'Avatar' },
  ]
  const userMenu = [
    { path: '/user/data-request', title: '申请获取数据', icon: 'Download' },
    { path: '/user/my-requests', title: '我的申请记录', icon: 'Document' },
    { path: '/user/my-results', title: '我的结果文件', icon: 'FolderOpened' },
    { path: '/user/messages', title: '消息中心', icon: 'Bell' },
  ]
  if (!userStore.isAdmin) return userMenu
  return userStore.isSuperAdmin ? [...adminMenu, ...superOnlyMenu] : adminMenu
})

onMounted(() => {
  messageStore.fetch().catch(() => {})
})

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    userStore.logout()
    router.push('/login')
  } else if (cmd === 'changePwd') {
    pwdForm.old_password = ''
    pwdForm.new_password = ''
    pwdForm.confirm_password = ''
    pwdDialogVisible.value = true
  }
}

// ---- 修改密码 ----
const pwdDialogVisible = ref(false)
const pwdLoading = ref(false)
const pwdFormRef = ref<FormInstance>()
const pwdForm = reactive({ old_password: '', new_password: '', confirm_password: '' })
const pwdRules: FormRules = {
  old_password: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
  new_password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    {
      validator: (_r, v, cb) => {
        const err = checkPasswordStrength(v, userStore.user?.username)
        err ? cb(new Error(err)) : cb()
      },
      trigger: 'blur',
    },
  ],
  confirm_password: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_r, v, cb) => (v === pwdForm.new_password ? cb() : cb(new Error('两次输入的密码不一致'))),
      trigger: 'blur',
    },
  ],
}

async function submitChangePwd() {
  await pwdFormRef.value?.validate()
  pwdLoading.value = true
  try {
    const res = await changePassword(pwdForm.old_password, pwdForm.new_password)
    ElMessage.success(res.message || '密码修改成功')
    pwdDialogVisible.value = false
  } finally {
    pwdLoading.value = false
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

/* 侧栏 */
.sider {
  background: linear-gradient(180deg, #0b1220 0%, #0e1726 100%);
  transition: width 0.2s ease;
  overflow: hidden;
}
.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.logo-mark {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #2f63ff, #6366f1);
  color: #fff;
  font-size: 18px;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(47, 99, 255, 0.4);
}
.logo-text {
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  white-space: nowrap;
}
.sider :deep(.el-menu) { border-right: none; background: transparent; }
.sider :deep(.el-menu-item) {
  height: 46px;
  line-height: 46px;
  margin: 2px 8px;
  border-radius: 8px;
  border-left: 3px solid transparent;
  transition: background 0.18s ease, color 0.18s ease;
}
.sider :deep(.el-menu-item:hover) {
  background: rgba(255, 255, 255, 0.06) !important;
  color: #fff !important;
}
.sider :deep(.el-menu-item.is-active) {
  background: rgba(47, 99, 255, 0.16) !important;
  color: #fff !important;
  font-weight: 600;
  border-left-color: var(--color-primary);
}
.sider :deep(.el-menu-item .el-icon) {
  color: rgba(255, 255, 255, 0.55);
}
.sider :deep(.el-menu-item.is-active .el-icon) {
  color: #fff;
}

/* 顶栏 */
.header {
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding: 0 20px;
  height: 60px;
}
.left { display: flex; align-items: center; gap: 16px; }
.collapse-btn {
  font-size: 20px;
  cursor: pointer;
  color: var(--text-secondary);
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  transition: background 0.18s ease, color 0.18s ease;
}
.collapse-btn:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.right { display: flex; align-items: center; gap: 18px; }
.icon-btn {
  font-size: 20px;
  cursor: pointer;
  color: var(--text-secondary);
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  transition: background 0.18s ease, color 0.18s ease;
}
.icon-btn:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.bell { cursor: pointer; }
.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  transition: background 0.18s ease;
}
.user-info:hover { background: var(--bg-hover); }
.username { font-size: 14px; color: var(--text-regular); }

.main { background: var(--bg-app); padding: 20px; }

/* 消息通知 */
.msg-pop .msg-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  font-weight: 600;
  color: var(--text-title);
}
.msg-item {
  padding: 10px 4px;
  border-bottom: 1px solid var(--divider);
  cursor: pointer;
  border-left: 3px solid transparent;
  padding-left: 10px;
  transition: background 0.18s ease;
}
.msg-item:hover { background: var(--bg-hover); }
.msg-item.unread {
  background: var(--color-primary-soft);
  border-left-color: var(--color-primary);
}
.msg-title { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.msg-content {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
  line-height: 1.5;
}
</style>
