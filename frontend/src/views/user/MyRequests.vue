<template>
  <el-card>
    <template #header>我的申请记录</template>
    <el-table :data="list" v-loading="loading" stripe style="width: 100%">
      <el-table-column prop="id" label="申请ID" width="80" />
      <el-table-column prop="data_name" label="数据名称" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="apply_time" label="申请时间" width="170" />
      <el-table-column prop="finish_time" label="完成时间" width="170">
        <template #default="{ row }">{{ row.finish_time || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button v-if="row.status === 'completed'" type="primary" link @click="viewResult(row)">查看结果</el-button>
          <el-tooltip v-if="row.status === 'rejected'" :content="row.reject_reason || '已驳回'">
            <el-button type="danger" link>驳回原因</el-button>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { DataApply } from '@/types'
import { getMyApplies } from '@/api/messages'

const router = useRouter()
const list = ref<DataApply[]>([])
const loading = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    list.value = await getMyApplies()
  } catch {
    /* 拦截器处理 */
  } finally {
    loading.value = false
  }
})

function statusType(s: string) {
  return ({ pending: 'info', processing: 'warning', completed: 'success', rejected: 'danger' } as Record<string, string>)[s] || 'info'
}
function statusText(s: string) {
  return ({ pending: '待审核', processing: '处理中', completed: '已完成', rejected: '已驳回' } as Record<string, string>)[s] || s
}
function viewResult(row: DataApply) {
  router.push('/user/my-results')
}
</script>
