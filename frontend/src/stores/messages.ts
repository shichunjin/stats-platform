import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Message } from '@/types'
import { getMessages, markMessageRead, markAllRead } from '@/api/messages'

export const useMessageStore = defineStore('messages', () => {
  const list = ref<Message[]>([])

  const unreadCount = computed(() => list.value.filter((m) => !m.read).length)

  async function fetch() {
    list.value = await getMessages()
  }

  async function read(id: number) {
    await markMessageRead(id)
    const m = list.value.find((x) => x.id === id)
    if (m) m.read = true
  }

  async function readAll() {
    await markAllRead()
    list.value.forEach((m) => (m.read = true))
  }

  return { list, unreadCount, fetch, read, readAll }
})
