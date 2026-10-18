<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">我的申请记录</div>
          <div class="page-header__desc">查看数据申请的处理进度与结果</div>
        </div>
      </div>
    </template>
    <el-table :data="list" v-loading="loading" stripe style="width: 100%">
      <el-table-column prop="id" label="申请ID" width="80" />
      <el-table-column prop="data_name" label="数据名称" />
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <span class="status-cell">
            <span class="status-dot" :class="`status-dot--${statusDot(row.status)}`"></span>
            <span class="tag" :class="statusTag(row.status)">{{ statusText(row.status) }}</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="apply_time" label="申请时间" width="170" />
      <el-table-column prop="finish_time" label="完成时间" width="170">
        <template #default="{ row }">{{ row.finish_time || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'completed'" type="primary" link @click="viewResult(row)">查看结果</el-button>
          <el-tooltip v-if="row.status === 'rejected'" :content="row.reject_reason || '已驳回'">
            <el-button type="danger" link>驳回原因</el-button>
          </el-tooltip>
          <el-tooltip v-if="row.status === 'failed'" :content="row.reject_reason || '生成失败'">
            <el-button type="danger" link>失败原因</el-button>
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

function statusTag(s: string) {
  return ({ pending: 'tag-pending', processing: 'tag-running', generating: 'tag-running', completed: 'tag-done', failed: 'tag-reject', rejected: 'tag-reject' } as Record<string, string>)[s] || 'tag-pending'
}
function statusDot(s: string) {
  return ({ pending: 'pending', processing: 'running', generating: 'running', completed: 'done', failed: 'reject', rejected: 'reject' } as Record<string, string>)[s] || 'pending'
}
function statusText(s: string) {
  return ({ pending: '待审核', processing: '处理中', generating: '生成中', completed: '已完成', failed: '生成失败', rejected: '已驳回' } as Record<string, string>)[s] || s
}
function viewResult(row: DataApply) {
  router.push('/user/my-results')
}
</script>

<style scoped>
.status-cell { display: inline-flex; align-items: center; gap: 4px; }
.tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  line-height: 18px;
}
</style>
