<template>
  <div class="dashboard">
    <div class="page-header">
      <div>
        <div class="page-header__title">你好，{{ userStore.user?.display_name || userStore.user?.username }} 👋</div>
        <div class="page-header__desc">今天也要高效处理数据，记得定期检查待办与消息</div>
      </div>
    </div>

    <el-row :gutter="16">
      <el-col :span="6" v-for="card in cards" :key="card.title">
        <el-card shadow="never" class="stat-card card card--hover" :class="{ 'card--clickable': !!card.path }" @click="card.path && router.push(card.path)">
          <div class="stat-icon" :style="{ background: card.color }">
            <el-icon :size="26"><component :is="card.icon" /></el-icon>
          </div>
          <div class="stat-info">
            <div class="stat-value tnum">{{ card.value }}</div>
            <div class="stat-label">{{ card.title }}</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :span="12">
        <el-card shadow="never" class="card">
          <template #header>
            <div class="card-header">
              <span class="card-header__title">快捷操作</span>
            </div>
          </template>
          <div class="quick-actions">
            <el-button type="primary" @click="connect">
              <el-icon><Connection /></el-icon>&nbsp;连接 Windows 分析平台
            </el-button>
            <!-- 安全修复 A1：「获取数据」直拉全表入口已下线，取数统一走「申请获取数据」 -->
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never" class="card">
          <template #header>
            <div class="card-header">
              <span class="card-header__title">最近消息</span>
              <el-button link type="primary" size="small" @click="$router.push('/user/messages')">查看全部</el-button>
            </div>
          </template>
          <el-empty v-if="!messageStore.list.length" description="暂无消息" :image-size="60" />
          <div v-else class="msg-list">
            <div v-for="m in messageStore.list.slice(0, 5)" :key="m.id" class="msg-row" @click="m.link && $router.push(m.link)">
              <span class="msg-dot" :class="`dot--${m.type}`"></span>
              <span class="msg-text">{{ m.title }}</span>
              <span class="msg-time">{{ m.created_at }}</span>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { useMessageStore } from '@/stores/messages'
import { connectSession } from '@/api/session'
import { getMyApplies } from '@/api/messages'
import { getMyResults } from '@/api/results'

const router = useRouter()
const userStore = useUserStore()
const messageStore = useMessageStore()

// 首页统计计数（真实拉取，不再硬编码 "--"）
const applyCount = ref<number | null>(null)
const resultCount = ref<number | null>(null)

const cards = computed(() => {
  const isAdmin = userStore.isAdmin
  return [
    {
      title: isAdmin ? '待处理申请' : '我的申请',
      value: applyCount.value ?? '--',
      icon: 'Document',
      color: 'linear-gradient(135deg,#2f63ff,#5b7bff)',
      path: isAdmin ? '/admin/pending-data' : '/user/my-requests',
    },
    {
      title: '结果文件',
      value: resultCount.value ?? '--',
      icon: 'FolderOpened',
      color: 'linear-gradient(135deg,#10b981,#34d399)',
      path: '/user/my-results',
    },
    {
      title: '未读消息',
      value: messageStore.unreadCount,
      icon: 'Bell',
      color: 'linear-gradient(135deg,#f59e0b,#fbbf24)',
      path: '/user/messages',
    },
  ]
})

onMounted(async () => {
  messageStore.fetch().catch(() => {})
  // 两个计数接口：管理员从待处理数据申请拉（admin 路径），普通用户拉自己的申请
  try {
    const list = await getMyApplies()
    applyCount.value = list.length
  } catch {
    /* 拦截器处理 */
  }
  try {
    const r = await getMyResults()
    resultCount.value = (r?.pending?.length || 0) + (r?.published?.length || 0)
  } catch {
    /* 拦截器处理 */
  }
})

async function connect() {
  try {
    const res = await connectSession()
    if (res.guac_url) window.open(res.guac_url, '_blank')
    ElMessage.success('已建立 Windows 分析会话')
  } catch {
    /* 拦截器处理 */
  }
}
</script>

<style scoped>
.dashboard .page-header { margin-bottom: 20px; }
.stat-card {
  display: flex;
  align-items: center;
  gap: 16px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
}
.stat-icon {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.15);
}
.stat-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-title);
  line-height: 1.2;
}
.stat-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}
.card { border-radius: var(--radius-lg); border: 1px solid var(--border-light); }
.card--clickable { cursor: pointer; transition: transform 0.18s ease, box-shadow 0.18s ease; }
.card--clickable:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12); }
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-title);
}
.quick-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.msg-list { display: flex; flex-direction: column; }
.msg-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 6px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.18s ease;
}
.msg-row:hover { background: var(--bg-hover); }
.msg-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot--success { background: var(--status-done); }
.dot--warning { background: var(--status-pending); }
.dot--info { background: var(--status-running); }
.dot--error, .dot--danger { background: var(--status-reject); }
.msg-text {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-time { font-size: 12px; color: var(--text-placeholder); }
</style>
