<template>
  <el-card>
    <template #header>审计日志</template>
    <el-table :data="list" v-loading="loading" stripe>
      <el-table-column prop="created_at" label="时间" width="170" />
      <el-table-column prop="user_id" label="用户ID" width="100" />
      <el-table-column prop="action" label="操作" width="180" />
      <el-table-column prop="detail" label="详情" show-overflow-tooltip />
      <el-table-column prop="ip_addr" label="来源IP" width="140" />
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AuditLog } from '@/types'
import { getAuditLog } from '@/api/admin'

const list = ref<AuditLog[]>([])
const loading = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    list.value = await getAuditLog()
  } catch {
    /* 拦截器处理 */
  } finally {
    loading.value = false
  }
})
</script>
