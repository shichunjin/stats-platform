<template>
  <el-card>
    <template #header>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span>消息中心</span>
        <el-button size="small" @click="readAll">全部已读</el-button>
      </div>
    </template>
    <el-timeline v-if="messageStore.list.length">
      <el-timeline-item
        v-for="m in messageStore.list"
        :key="m.id"
        :type="timelineType(m.type)"
        :timestamp="m.created_at"
      >
        <div class="msg-card" :class="{ unread: !m.read }" @click="onClick(m)">
          <div class="msg-title">
            {{ m.title }}
            <el-tag v-if="!m.read" size="small" type="danger" style="margin-left: 8px;">未读</el-tag>
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
.msg-card { padding: 4px 8px; cursor: pointer; border-radius: 4px; }
.msg-card.unread { background: #ecf5ff; }
.msg-title { font-weight: 500; }
.msg-content { font-size: 13px; color: #909399; margin-top: 4px; }
</style>
