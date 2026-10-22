import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useUserStore } from '@/stores/user'

const Layout = () => import('@/components/Layout/index.vue')

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'Login', component: () => import('@/views/login/Login.vue'), meta: { hideTab: true } },
  {
    path: '/',
    component: Layout,
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'Dashboard', component: () => import('@/views/dashboard/Dashboard.vue'), meta: { title: '首页', icon: 'HomeFilled' } },

      // ---- 用户端（管理员 / 超管也可以发起数据申请、查看自己的结果） ----
      { path: 'user/data-request', name: 'DataRequest', component: () => import('@/views/user/DataRequest.vue'), meta: { title: '申请获取数据', icon: 'Download', roles: ['user', 'admin', 'superadmin'] } },
      { path: 'user/my-requests', name: 'MyRequests', component: () => import('@/views/user/MyRequests.vue'), meta: { title: '我的申请记录', icon: 'Document', roles: ['user', 'admin', 'superadmin'] } },
      { path: 'user/my-results', name: 'MyResults', component: () => import('@/views/user/MyResults.vue'), meta: { title: '我的结果文件', icon: 'FolderOpened', roles: ['user', 'admin', 'superadmin'] } },
      { path: 'user/messages', name: 'Messages', component: () => import('@/views/user/Messages.vue'), meta: { title: '消息中心', icon: 'Bell', roles: ['user', 'admin', 'superadmin'] } },

      // ---- 管理员端（superadmin 继承全部管理员页面） ----
      { path: 'admin/pending-data', name: 'PendingData', component: () => import('@/views/admin/PendingData.vue'), meta: { title: '待处理数据申请', icon: 'List', roles: ['admin', 'superadmin'] } },
      { path: 'admin/data-filter', name: 'DataFilter', component: () => import('@/views/admin/DataFilter.vue'), meta: { title: '数据筛选与生成', icon: 'Filter', roles: ['admin', 'superadmin'] } },
      { path: 'admin/pending-exports', name: 'PendingExports', component: () => import('@/views/admin/PendingExports.vue'), meta: { title: '待审核导出申请', icon: 'Checked', roles: ['admin', 'superadmin'] } },
      { path: 'admin/platform-config', name: 'PlatformConfig', component: () => import('@/views/admin/PlatformConfig.vue'), meta: { title: '连接数据分析PC', icon: 'Connection', roles: ['admin', 'superadmin'] } },
      { path: 'admin/audit', name: 'AuditLog', component: () => import('@/views/admin/AuditLog.vue'), meta: { title: '审计日志', icon: 'DocumentCopy', roles: ['admin', 'superadmin'] } },

      // ---- 超级管理员专属 ----
      { path: 'admin/user-manage', name: 'UserManage', component: () => import('@/views/admin/UserManage.vue'), meta: { title: '用户管理', icon: 'Avatar', roles: ['superadmin'] } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const userStore = useUserStore()
  if (to.path === '/login') return true
  if (!userStore.isLoggedIn) return { path: '/login' }
  if (!userStore.user) {
    try {
      await userStore.fetchUser()
    } catch {
      return { path: '/login' }
    }
  }
  // 角色校验
  const roles = to.meta?.roles as string[] | undefined
  if (roles && !roles.includes(userStore.user?.role || '')) {
    return { path: '/dashboard' }
  }
  return true
})

export default router
