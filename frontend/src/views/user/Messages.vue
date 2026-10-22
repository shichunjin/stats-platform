<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">消息中心</div>
          <div class="page-header__desc">系统通知与审核结果</div>
        </div>
        <el-button size="small" @click="readAll">全部已读</el-button>
      </div>
    </template>
    <el-timeline v-if="messageStore.list.length">
      <el-timeline-item
        v-for="m in messageStore.list"
        :key="m.id"
        :type="timelineType(m.type)"
        :timestamp="formatTime(m.created_at)"
        placement="top"
      >
        <div class="msg-card" :class="{ unread: !m.read }" @click="onClick(m)">
          <div class="msg-title">
            {{ m.title }}
            <span v-if="!m.read" class="unread-dot"></span>
          </div>
          <div class="msg-content">{{ m.content }}</div>
        </div>
      </el-timeline-item>
    </el-timeline>
    <el-empty v-else description="暂无消息" />
  </el-card>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessageStore } from '@/stores/messages'
import type { Message } from '@/types'
import { formatTime } from '@/utils'

const router = useRouter()
const messageStore = useMessageStore()

onMounted(() => messageStore.fetch())

function timelineType(t: string) {
  return ({ success: 'success', warning: 'warning', info: 'primary' } as Record<string, string>)[t] || 'primary'
}

function onClick(m: Message) {
  if (!m.read) messageStore.read(m.id)
  if (m.link) router.push(m.link)
}

function readAll() {
  messageStore.readAll()
}
</script>

<style scoped>
.msg-card {
  padding: 12px 14px;
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: background 0.18s ease;
}
.msg-card:hover { background: var(--bg-hover); }
.msg-card.unread { background: var(--color-primary-soft); border-left: 3px solid var(--color-primary); }
.msg-title {
  font-weight: 600;
  color: var(--text-title);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.unread-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  flex-shrink: 0;
}
.msg-content {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 6px;
  line-height: 1.5;
}
</style>
