<template>
  <div class="dashboard">
    <el-row :gutter="16">
      <el-col :span="6" v-for="card in cards" :key="card.title">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-icon" :style="{ background: card.color }">
            <el-icon :size="28"><component :is="card.icon" /></el-icon>
          </div>
          <div class="stat-info">
            <div class="stat-value">{{ card.value }}</div>
            <div class="stat-label">{{ card.title }}</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top: 16px">
      <el-col :span="12">
        <el-card>
          <template #header>快捷操作</template>
          <div class="quick-actions">
            <el-button type="primary" @click="connect">
              <el-icon><Connection /></el-icon>&nbsp;连接 Windows 分析平台
            </el-button>
            <el-button type="success" @click="fetch" :loading="fetching">
              <el-icon><Download /></el-icon>&nbsp;获取数据
            </el-button>
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header>最近消息</template>
          <el-empty v-if="!messageStore.list.length" description="暂无消息" :image-size="60" />
          <div v-else class="msg-list">
            <div v-for="m in messageStore.list.slice(0, 5)" :key="m.id" class="msg-row">
              <el-tag size="small" :type="tagType(m.type)">{{ m.type }}</el-tag>
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
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { useMessageStore } from '@/stores/messages'
import { connectSession } from '@/api/session'
import { fetchData } from '@/api/data'

const userStore = useUserStore()
const messageStore = useMessageStore()

const fetching = ref(false)

const cards = computed(() => [
  { title: '我的申请', value: '--', icon: 'Document', color: '#409eff' },
  { title: '结果文件', value: '--', icon: 'FolderOpened', color: '#67c23a' },
  { title: '未读消息', value: messageStore.unreadCount, icon: 'Bell', color: '#e6a23c' },
  { title: '数据权限', value: userStore.user?.scopes?.length || 0, icon: 'Key', color: '#909399' },
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

async function fetch() {
  fetching.value = true
  try {
    const res = await fetchData()
    ElMessage.success(`数据已生成：${res.filename}（${res.rows} 行 × ${res.columns} 列）`)
  } catch {
    /* 拦截器处理 */
  } finally {
    fetching.value = false
  }
}

function tagType(t: string) {
  return ({ success: 'success', warning: 'warning', info: 'info' } as Record<string, string>)[t] || 'info'
}
</script>

<style scoped>
.stat-card { display: flex; align-items: center; gap: 16px; }
.stat-icon {
  width: 56px; height: 56px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center; color: #fff;
}
.stat-value { font-size: 24px; font-weight: 700; color: #303133; }
.stat-label { font-size: 13px; color: #909399; margin-top: 2px; }
.quick-actions { display: flex; gap: 12px; flex-wrap: wrap; }
.msg-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.msg-text { flex: 1; font-size: 13px; }
.msg-time { font-size: 12px; color: #999; }
</style>
