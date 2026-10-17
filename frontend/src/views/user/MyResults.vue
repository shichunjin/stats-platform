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
      <el-table-column label="大小" width="110">
        <template #default="{ row }">{{ formatSize(row.file_size) }}</template>
      </el-table-column>
      <el-table-column prop="download_count" label="下载次数" width="90" />
      <el-table-column prop="created_at" label="生成时间" width="170">
        <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="有效期" width="190">
        <template #default="{ row }">
          <template v-if="row.expires_at">
            <el-tag v-if="isExpired(row)" type="danger" size="small">已过期</el-tag>
            <span v-else>{{ formatTime(row.expires_at) }} 前有效</span>
          </template>
          <span v-else>永久有效</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-tooltip :disabled="!isExpired(row)" content="文件已过期，无法下载" placement="top">
            <span>
              <el-button type="primary" link :disabled="isExpired(row)" @click="download(row)">
                {{ isExpired(row) ? '已过期' : '下载' }}
              </el-button>
            </span>
          </el-tooltip>
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
    const total = res.registered + res.auto_approved
    if (total === 0) {
      ElMessage.warning('没有新的结果文件可申请（请先在 Windows 平台保存结果到待导出目录）')
      return
    }
    if (res.auto_approved > 0) {
      ElMessage.success(`${res.auto_approved} 个文件与原始数据相似度低于 60%，已免审核发布，可直接下载`)
    }
    if (res.registered > 0) {
      ElMessage.warning(`${res.registered} 个文件与原始数据相似度达到 60% 以上，需管理员审核后才能下载`)
    }
    load()
  } catch {
    /* 拦截器处理 */
  }
}

async function download(row: ExportResult) {
  if (isExpired(row)) {
    ElMessage.warning('文件已过期，无法下载')
    return
  }
  try {
    const blob = await downloadResult(row.id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = row.result_name || `result_${row.id}`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    /* 拦截器处理（过期时后端返回 410 已过期提示） */
  }
}

// 有效期判断（expires_at 为 null 表示永久有效）
function isExpired(row: ExportResult): boolean {
  if (!row.expires_at) return false
  return new Date(row.expires_at).getTime() < Date.now()
}

function formatTime(v?: string | null) {
  if (!v) return '-'
  return String(v).replace('T', ' ').slice(0, 16)
}

function formatSize(b?: number | null) {
  if (!b) return '-'
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1024 / 1024).toFixed(2) + ' MB'
}
</script>
