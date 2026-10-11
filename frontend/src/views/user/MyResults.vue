<template>
  <el-card>
    <template #header>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span>我的结果文件</span>
        <el-button type="primary" size="small" @click="onExport">申请导出结果</el-button>
      </div>
    </template>

    <h4 style="margin: 8px 0; color: #606266;">导出申请</h4>
    <el-table :data="pending" v-loading="loading" stripe>
      <el-table-column prop="file_name" label="文件名" />
      <el-table-column prop="file_type" label="类型" width="100" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'danger' : 'warning'" size="small">
            {{ { pending: '待审', approved: '通过', rejected: '拒绝' }[row.status] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="review_reason" label="原因" />
      <el-table-column prop="created_at" label="创建时间" width="170" />
    </el-table>

    <h4 style="margin: 20px 0 8px; color: #606266;">已发布（可下载）</h4>
    <el-table :data="published" v-loading="loading" stripe>
      <el-table-column prop="result_name" label="文件名" />
      <el-table-column label="大小" width="120">
        <template #default="{ row }">{{ formatSize(row.file_size) }}</template>
      </el-table-column>
      <el-table-column prop="download_count" label="下载次数" width="100" />
      <el-table-column prop="created_at" label="发布时间" width="170" />
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button type="primary" link @click="download(row.id)">下载</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { PendingFile, ExportResult } from '@/types'
import { getMyResults, requestExport, downloadResult } from '@/api/results'

const pending = ref<PendingFile[]>([])
const published = ref<ExportResult[]>([])
const loading = ref(false)

onMounted(load)

async function load() {
  loading.value = true
  try {
    const res = await getMyResults()
    pending.value = res.pending
    published.value = res.published
  } catch {
    /* 拦截器处理 */
  } finally {
    loading.value = false
  }
}

async function onExport() {
  try {
    const res = await requestExport()
    if (res.registered === 0) {
      ElMessage.warning('没有新的结果文件可申请（请先在 Windows 平台保存结果到待导出目录）')
    } else {
      ElMessage.success(`已提交 ${res.registered} 个导出申请，等待管理员审核`)
      load()
    }
  } catch {
    /* 拦截器处理 */
  }
}

async function download(id: number) {
  try {
    const blob = await downloadResult(id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `result_${id}`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    /* 拦截器处理 */
  }
}

function formatSize(b?: number | null) {
  if (!b) return '-'
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1024 / 1024).toFixed(2) + ' MB'
}
</script>
