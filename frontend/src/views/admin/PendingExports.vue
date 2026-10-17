<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">
            待审核导出申请
            <el-badge :value="filteredList.length" class="count-badge" />
          </div>
          <div class="page-header__desc">与原始数据相似度 ≥ 60% 的导出申请需人工审核通过后发布</div>
        </div>
        <div class="filter-bar">
          <el-input v-model="keyword" placeholder="按文件名搜索" clearable style="width: 200px" :prefix-icon="Search" />
          <el-select v-model="typeFilter" placeholder="按类型筛选" clearable style="width: 130px">
            <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
      </div>
    </template>

    <el-table :data="filteredList" v-loading="loading" stripe>
      <el-table-column label="文件名" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="file-cell">
            <el-icon class="file-icon"><Document /></el-icon>
            {{ row.file_name }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="user_id" label="用户ID" width="90" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <span class="tag tag-expired">{{ row.file_type || '未知' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="相似度" width="120">
        <template #default="{ row }">
          <span class="similarity-value tnum" :class="simLevel(row)">{{ simText(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="申请时间" width="170" />
      <el-table-column label="审核说明" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ row.review_reason || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <el-button type="success" link @click="approve(row)">通过</el-button>
          <el-button type="danger" link @click="reject(row)">驳回</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="rejectVisible" title="驳回导出申请" width="480px">
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
import { ElMessage } from 'element-plus'
import { Search, Document } from '@element-plus/icons-vue'
import type { PendingFile } from '@/types'
import { getPendingExports, approveExport, rejectExport } from '@/api/admin'

const list = ref<PendingFile[]>([])
const loading = ref(false)
const keyword = ref('')
const typeFilter = ref('')
const rejectVisible = ref(false)
const rejectReason = ref('')
const currentId = ref<number | null>(null)
const submitting = ref(false)

const typeOptions = computed(() => [...new Set(list.value.map((x) => x.file_type).filter(Boolean))])

const filteredList = computed(() => {
  let rows = list.value
  if (keyword.value) rows = rows.filter((x) => x.file_name.includes(keyword.value))
  if (typeFilter.value) rows = rows.filter((x) => x.file_type === typeFilter.value)
  return rows
})

// 从 review_reason 中提取相似度百分比（如 "相似度 65%"）
function simPercent(row: PendingFile): number | null {
  const m = String(row.review_reason || '').match(/(\d+(?:\.\d+)?)\s*%/)
  return m ? Number(m[1]) : null
}
function simText(row: PendingFile): string {
  const p = simPercent(row)
  return p === null ? '—' : `${p}%`
}
function simLevel(row: PendingFile): string {
  const p = simPercent(row)
  if (p === null) return 'sim-unknown'
  if (p >= 80) return 'sim-high'
  if (p >= 60) return 'sim-mid'
  return 'sim-low'
}

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
    ElMessage.success('已驳回')
    rejectVisible.value = false
    load()
  } catch {
    /* 拦截器处理 */
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.page-header { align-items: center; margin-bottom: 0; }
.filter-bar { display: flex; gap: 8px; flex-wrap: wrap; }
.count-badge { margin-left: 8px; }
.file-cell { display: inline-flex; align-items: center; gap: 8px; }
.file-icon { color: var(--text-secondary); }
.similarity-value { font-weight: 600; font-size: 14px; }
.sim-high { color: var(--status-reject); }
.sim-mid { color: var(--status-pending); }
.sim-low { color: var(--status-done); }
.sim-unknown { color: var(--text-secondary); }
.tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  line-height: 18px;
}
</style>
