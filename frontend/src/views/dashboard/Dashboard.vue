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
        <el-card shadow="never" class="stat-card card card--hover">
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
import { computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { useMessageStore } from '@/stores/messages'
import { connectSession } from '@/api/session'

const userStore = useUserStore()
const messageStore = useMessageStore()

const cards = computed(() => [
  { title: '我的申请', value: '--', icon: 'Document', color: 'linear-gradient(135deg,#2f63ff,#5b7bff)' },
  { title: '结果文件', value: '--', icon: 'FolderOpened', color: 'linear-gradient(135deg,#10b981,#34d399)' },
  { title: '未读消息', value: messageStore.unreadCount, icon: 'Bell', color: 'linear-gradient(135deg,#f59e0b,#fbbf24)' },
  { title: '数据权限', value: userStore.user?.scopes?.length || 0, icon: 'Key', color: 'linear-gradient(135deg,#64748b,#94a3b8)' },
])

onMounted(() => {
  messageStore.fetch().catch(() => {})
})

async function connect() {
  try {
    const res = await connectSession('rstudio')
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
