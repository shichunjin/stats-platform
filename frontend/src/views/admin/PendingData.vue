<template>
  <el-card>
    <template #header>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span>待处理数据申请</span>
        <div>
          <el-select v-model="statusFilter" placeholder="按状态筛选" clearable style="width: 140px; margin-right: 12px">
            <el-option label="待审核" value="pending" />
            <el-option label="处理中" value="processing" />
            <el-option label="已完成" value="completed" />
            <el-option label="已驳回" value="rejected" />
          </el-select>
        </div>
      </div>
    </template>

    <el-table :data="filteredList" v-loading="loading" stripe @selection-change="onSelection">
      <el-table-column type="selection" width="48" />
      <el-table-column prop="id" label="申请ID" width="80" />
      <el-table-column prop="data_name" label="数据名称" />
      <el-table-column prop="purpose" label="用途" show-overflow-tooltip />
      <el-table-column label="优先级" width="90">
        <template #default="{ row }">
          <el-tag :type="priorityType(row.priority)" size="small">{{ priorityText(row.priority) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="apply_time" label="申请时间" width="170" />
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'pending'" type="primary" link @click="goFilter(row)">分配数据</el-button>
          <el-button v-if="row.status === 'pending'" type="danger" link @click="openReject(row)">驳回</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div v-if="selected.length" style="margin-top: 12px">
      已选 {{ selected.length }} 项
      <el-button size="small" type="danger" @click="batchReject">批量驳回</el-button>
    </div>

    <el-dialog v-model="rejectVisible" title="驳回申请" width="480px">
      <el-input v-model="rejectReason" type="textarea" :rows="3" placeholder="请输入驳回原因" />
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="confirmReject">确认驳回</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { DataApply } from '@/types'
import { getDataApplies, rejectDataApply } from '@/api/admin'

const router = useRouter()
const list = ref<DataApply[]>([])
const loading = ref(false)
const statusFilter = ref('')
const selected = ref<DataApply[]>([])

const filteredList = computed(() =>
  statusFilter.value ? list.value.filter((x) => x.status === statusFilter.value) : list.value,
)

onMounted(load)

async function load() {
  loading.value = true
  try {
    list.value = await getDataApplies()
  } catch {
    /* 拦截器处理 */
  } finally {
    loading.value = false
  }
}

function onSelection(rows: DataApply[]) {
  selected.value = rows
}

function goFilter(row: DataApply) {
  router.push({ path: '/admin/data-filter', query: { applyId: row.id, userId: row.target_user_id } })
}

// 驳回
const rejectVisible = ref(false)
const rejectReason = ref('')
const currentId = ref<number | null>(null)
const submitting = ref(false)

function openReject(row: DataApply) {
  currentId.value = row.id
  rejectReason.value = ''
  rejectVisible.value = true
}

async function confirmReject() {
  if (!currentId.value) return
  submitting.value = true
  try {
    await rejectDataApply(currentId.value, rejectReason.value || '审核拒绝')
    ElMessage.success('已驳回')
    rejectVisible.value = false
    load()
  } catch {
    /* 拦截器处理 */
  } finally {
    submitting.value = false
  }
}

async function batchReject() {
  try {
    await ElMessageBox.confirm(`确认驳回选中的 ${selected.value.length} 条申请？`, '提示', { type: 'warning' })
    ElMessage.success('批量驳回操作已记录')
    load()
  } catch {
    /* 取消 */
  }
}

const statusType = (s: string) =>
  ({ pending: 'info', processing: 'warning', completed: 'success', rejected: 'danger' } as Record<string, string>)[s] || 'info'
const statusText = (s: string) =>
  ({ pending: '待审核', processing: '处理中', completed: '已完成', rejected: '已驳回' } as Record<string, string>)[s] || s
const priorityType = (p: string) =>
  ({ low: 'info', medium: 'warning', high: 'danger' } as Record<string, string>)[p] || 'info'
const priorityText = (p: string) => ({ low: '低', medium: '中', high: '高' } as Record<string, string>)[p] || p
</script>
