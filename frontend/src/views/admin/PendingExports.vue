<template>
  <el-card>
    <template #header>待审核导出申请</template>
    <el-table :data="list" v-loading="loading" stripe>
      <el-table-column prop="file_name" label="文件名" />
      <el-table-column prop="user_id" label="用户ID" width="100" />
      <el-table-column prop="file_type" label="类型" width="100" />
      <el-table-column prop="created_at" label="申请时间" width="170" />
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <el-button type="success" link @click="approve(row)">通过</el-button>
          <el-button type="danger" link @click="reject(row)">拒绝</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="rejectVisible" title="拒绝导出申请" width="480px">
      <el-input v-model="rejectReason" type="textarea" :rows="3" placeholder="请输入拒绝原因" />
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="confirmReject">确认拒绝</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { PendingFile } from '@/types'
import { getPendingExports, approveExport, rejectExport } from '@/api/admin'

const list = ref<PendingFile[]>([])
const loading = ref(false)
const rejectVisible = ref(false)
const rejectReason = ref('')
const currentId = ref<number | null>(null)
const submitting = ref(false)

onMounted(load)

async function load() {
  loading.value = true
  try {
    list.value = await getPendingExports()
  } catch {
    /* 拦截器处理 */
  } finally {
    loading.value = false
  }
}

async function approve(row: PendingFile) {
  try {
    await approveExport(row.id, '审核通过')
    ElMessage.success(`已通过：${row.file_name}`)
    load()
  } catch {
    /* 拦截器处理 */
  }
}

function reject(row: PendingFile) {
  currentId.value = row.id
  rejectReason.value = ''
  rejectVisible.value = true
}

async function confirmReject() {
  if (!currentId.value) return
  submitting.value = true
  try {
    await rejectExport(currentId.value, rejectReason.value || '审核拒绝')
    ElMessage.success('已拒绝')
    rejectVisible.value = false
    load()
  } catch {
    /* 拦截器处理 */
  } finally {
    submitting.value = false
  }
}
</script>
