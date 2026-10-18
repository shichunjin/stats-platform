<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">
            待处理数据申请
            <el-badge :value="filteredList.length" class="count-badge" />
          </div>
          <div class="page-header__desc">审核用户的数据获取申请，分配或驳回</div>
        </div>
        <div class="filter-bar">
          <el-select v-model="applicantFilter" placeholder="按申请人筛选" clearable filterable style="width: 150px">
            <el-option v-for="name in applicantOptions" :key="name" :label="name" :value="name" />
          </el-select>
          <el-date-picker
            v-model="dateFilter"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="申请开始日期"
            end-placeholder="申请结束日期"
            style="width: 240px"
          />
          <el-select v-model="statusFilter" placeholder="按状态筛选" clearable style="width: 130px">
            <el-option label="待审核" value="pending" />
            <el-option label="处理中" value="processing" />
            <el-option label="生成中" value="generating" />
            <el-option label="已完成" value="completed" />
            <el-option label="生成失败" value="failed" />
            <el-option label="已驳回" value="rejected" />
          </el-select>
        </div>
      </div>
    </template>

    <el-table :data="pagedList" v-loading="loading" stripe @selection-change="onSelection" @sort-change="onSort">
      <el-table-column type="selection" width="48" :selectable="(row) => !['completed', 'generating'].includes(row.status)" />
      <el-table-column prop="id" label="申请ID" width="80" sortable="custom" />
      <el-table-column label="申请人" width="110">
        <template #default="{ row }">{{ row.display_name || row.username || `用户${row.target_user_id ?? '-'}` }}</template>
      </el-table-column>
      <el-table-column prop="data_name" label="数据名称" width="110" />
      <el-table-column prop="purpose" label="用途" show-overflow-tooltip />
      <el-table-column label="优先级" width="90" sortable="custom">
        <template #default="{ row }">
          <span class="tag" :class="priorityTag(row.priority)">{{ priorityText(row.priority) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <span class="status-cell">
            <span class="status-dot" :class="`status-dot--${statusDot(row.status)}`"></span>
            <span class="tag" :class="statusTag(row.status)">{{ statusText(row.status) }}</span>
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="apply_time" label="申请时间" width="170" sortable="custom" />
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          <el-button v-if="row.status === 'pending'" type="success" link @click="goFilter(row)">分配数据</el-button>
          <el-button v-if="row.status === 'pending'" type="danger" link @click="openReject(row)">驳回</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div style="margin-top: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
      <div v-if="selected.length">
        已选 {{ selected.length }} 项
        <el-button size="small" type="primary" :loading="batchLoading" @click="batchProcess">批量通过</el-button>
        <el-button size="small" type="danger" :loading="batchLoading" @click="batchRejectVisible = true">批量驳回</el-button>
      </div>
      <span v-else />
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="filteredList.length"
        layout="total, prev, pager, next"
        background
      />
    </div>

    <!-- 申请详情 -->
    <el-dialog v-model="detailVisible" title="申请详情" width="560px">
      <el-descriptions v-if="detailRow" :column="1" border>
        <el-descriptions-item label="申请ID">{{ detailRow.id }}</el-descriptions-item>
        <el-descriptions-item label="申请人">{{ detailRow.display_name || detailRow.username }}</el-descriptions-item>
        <el-descriptions-item label="数据名称">{{ detailRow.data_name }}</el-descriptions-item>
        <el-descriptions-item label="用途">{{ detailRow.purpose }}</el-descriptions-item>
        <el-descriptions-item label="所需字段">
          <el-tag v-for="f in detailRow.fields" :key="f" size="small" style="margin-right:4px">{{ f }}</el-tag>
          <span v-if="!detailRow.fields?.length">-</span>
        </el-descriptions-item>
        <el-descriptions-item label="时间范围">
          {{ detailRow.time_range?.[0] || '不限' }} ~ {{ detailRow.time_range?.[1] || '不限' }}
        </el-descriptions-item>
        <el-descriptions-item label="优先级">{{ priorityText(detailRow.priority) }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusType(detailRow.status)" size="small">{{ statusText(detailRow.status) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item v-if="['rejected', 'failed'].includes(detailRow.status)"
                              :label="detailRow.status === 'failed' ? '失败原因' : '驳回原因'">
          {{ detailRow.reject_reason || '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="申请时间">{{ detailRow.apply_time }}</el-descriptions-item>
      </el-descriptions>
    </el-dialog>

    <!-- 单条驳回 -->
    <el-dialog v-model="rejectVisible" title="驳回申请" width="480px">
      <el-input v-model="rejectReason" type="textarea" :rows="3" placeholder="请输入驳回原因" />
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="confirmReject">确认驳回</el-button>
      </template>
    </el-dialog>

    <!-- 批量驳回 -->
    <el-dialog v-model="batchRejectVisible" title="批量驳回" width="480px">
      <p style="margin-top:0">将驳回选中的 {{ selected.length }} 条申请，并向申请人发送站内通知。</p>
      <el-input v-model="batchReason" type="textarea" :rows="3" placeholder="请输入统一驳回原因" />
      <template #footer>
        <el-button @click="batchRejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="batchLoading" @click="confirmBatchReject">确认驳回</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { DataApply } from '@/types'
import { getDataApplies, rejectDataApply, processDataApply } from '@/api/admin'

const router = useRouter()
const list = ref<DataApply[]>([])
const loading = ref(false)
const statusFilter = ref('')
const applicantFilter = ref('')
const dateFilter = ref<[string, string] | null>(null)
const selected = ref<DataApply[]>([])

// 客户端分页
const page = ref(1)
const pageSize = 10
// 排序（客户端）
const sortProp = ref('')
const sortOrder = ref<'asc' | 'desc'>('desc')

const applicantOptions = computed(() => {
  const names = list.value.map((x) => x.display_name || x.username || '')
  return [...new Set(names.filter(Boolean))]
})

const filteredList = computed(() => {
  let rows = list.value
  if (statusFilter.value) rows = rows.filter((x) => x.status === statusFilter.value)
  if (applicantFilter.value) {
    rows = rows.filter((x) => (x.display_name || x.username) === applicantFilter.value)
  }
  if (dateFilter.value && dateFilter.value.length === 2) {
    const [d1, d2] = dateFilter.value
    rows = rows.filter((x) => {
      const day = (x.apply_time || '').slice(0, 10)
      return day >= d1 && day <= d2
    })
  }
  if (sortProp.value) {
    const prop = sortProp.value as keyof DataApply
    const dir = sortOrder.value === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) => {
      const va = a[prop] ?? ''
      const vb = b[prop] ?? ''
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb)) * dir
    })
  }
  return rows
})

const pagedList = computed(() =>
  filteredList.value.slice((page.value - 1) * pageSize, page.value * pageSize),
)

function onSort({ prop, order }: { prop: string; order: string | null }) {
  sortProp.value = order ? prop : ''
  sortOrder.value = order === 'ascending' ? 'asc' : 'desc'
}

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

// ---- 详情 ----
const detailVisible = ref(false)
const detailRow = ref<DataApply | null>(null)
function openDetail(row: DataApply) {
  detailRow.value = row
  detailVisible.value = true
}

// ---- 分配数据（进入筛选生成页并携带申请上下文） ----
function goFilter(row: DataApply) {
  router.push({ path: '/admin/data-filter', query: { applyId: row.id, userId: row.target_user_id } })
}

// ---- 单条驳回 ----
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

// ---- 批量通过（pending → processing） ----
const batchLoading = ref(false)

async function batchProcess() {
  const ids = selected.value.filter((x) => x.status === 'pending').map((x) => x.id)
  if (!ids.length) {
    ElMessage.warning('选中的申请中没有待审核记录')
    return
  }
  try {
    await ElMessageBox.confirm(`确认将选中的 ${ids.length} 条申请置为“处理中”？`, '批量通过', { type: 'warning' })
  } catch {
    return
  }
  batchLoading.value = true
  try {
    const results = await Promise.allSettled(ids.map((id) => processDataApply(id)))
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const fail = results.length - ok
    if (fail) ElMessage.warning(`批量通过完成：成功 ${ok} 条，失败 ${fail} 条`)
    else ElMessage.success(`已批量通过 ${ok} 条申请`)
    load()
  } finally {
    batchLoading.value = false
  }
}

// ---- 批量驳回 ----
const batchRejectVisible = ref(false)
const batchReason = ref('')

async function confirmBatchReject() {
  const ids = selected.value.filter((x) => x.status !== 'completed').map((x) => x.id)
  if (!ids.length) {
    ElMessage.warning('选中的申请中没有可驳回记录')
    return
  }
  batchLoading.value = true
  try {
    const results = await Promise.allSettled(
      ids.map((id) => rejectDataApply(id, batchReason.value || '批量审核拒绝')),
    )
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const fail = results.length - ok
    if (fail) ElMessage.warning(`批量驳回完成：成功 ${ok} 条，失败 ${fail} 条`)
    else ElMessage.success(`已批量驳回 ${ok} 条申请`)
    batchRejectVisible.value = false
    load()
  } finally {
    batchLoading.value = false
  }
}

const statusTag = (s: string) =>
  ({ pending: 'tag-pending', processing: 'tag-running', generating: 'tag-running', completed: 'tag-done', failed: 'tag-reject', rejected: 'tag-reject' } as Record<string, string>)[s] || 'tag-pending'
const statusDot = (s: string) =>
  ({ pending: 'pending', processing: 'running', generating: 'running', completed: 'done', failed: 'reject', rejected: 'reject' } as Record<string, string>)[s] || 'pending'
const statusText = (s: string) =>
  ({ pending: '待审核', processing: '处理中', generating: '生成中', completed: '已完成', failed: '生成失败', rejected: '已驳回' } as Record<string, string>)[s] || s
const priorityTag = (p: string) =>
  ({ low: 'tag-expired', medium: 'tag-pending', high: 'tag-reject' } as Record<string, string>)[p] || 'tag-expired'
const priorityText = (p: string) => ({ low: '低', medium: '中', high: '高' } as Record<string, string>)[p] || p
</script>

<style scoped>
.page-header { align-items: center; margin-bottom: 0; }
.filter-bar { display: flex; gap: 8px; flex-wrap: wrap; }
.count-badge { margin-left: 8px; }
.status-cell { display: inline-flex; align-items: center; gap: 4px; }
.tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  line-height: 18px;
  background: var(--color-primary-bg);
  color: var(--color-primary);
}
.batch-bar { display: flex; align-items: center; gap: 8px; color: var(--text-regular); }
</style>
