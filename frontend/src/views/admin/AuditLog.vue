<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">审计日志</div>
          <div class="page-header__desc">平台所有关键操作的可追溯记录</div>
        </div>
        <div class="filter-bar">
          <el-select v-model="moduleFilter" placeholder="按模块筛选" clearable style="width: 150px">
            <el-option v-for="m in moduleOptions" :key="m.value" :label="m.label" :value="m.value" />
          </el-select>
          <el-select v-model="actionFilter" placeholder="按操作类型筛选" clearable filterable style="width: 180px">
            <el-option v-for="a in actionOptions" :key="a" :label="a" :value="a" />
          </el-select>
          <el-date-picker
            v-model="dateFilter"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 240px"
          />
        </div>
      </div>
    </template>

    <el-table :data="pagedList" v-loading="loading" stripe @sort-change="onSort">
      <el-table-column label="操作时间" width="170" sortable="custom" prop="created_at">
        <template #default="{ row }">{{ formatTime(row.created_at, true) }}</template>
      </el-table-column>
      <el-table-column prop="user_id" label="操作人(ID)" width="100" />
      <el-table-column label="操作模块" width="130">
        <template #default="{ row }">
          <span class="tag tag-expired">{{ moduleOf(row.action) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="action" label="操作类型" width="170" />
      <el-table-column prop="detail" label="操作内容" show-overflow-tooltip />
      <el-table-column prop="ip_addr" label="IP" width="130" />
      <el-table-column label="结果" width="90">
        <template #default="{ row }">
          <span class="status-cell">
            <span class="status-dot" :class="row.status === 'failed' ? 'status-dot--reject' : 'status-dot--done'"></span>
            <span class="tag" :class="row.status === 'failed' ? 'tag-reject' : 'tag-done'">
              {{ row.status === 'failed' ? '失败' : '成功' }}
            </span>
          </span>
        </template>
      </el-table-column>
    </el-table>

    <div class="pagination-wrap">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="filteredList.length"
        layout="total, prev, pager, next"
        background
      />
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AuditLog } from '@/types'
import { getAuditLog } from '@/api/admin'
import { formatTime } from '@/utils'

const list = ref<AuditLog[]>([])
const loading = ref(false)
const moduleFilter = ref('')
const actionFilter = ref('')
const dateFilter = ref<[string, string] | null>(null)

const page = ref(1)
const pageSize = 20
const sortProp = ref('')
const sortOrder = ref<'asc' | 'desc'>('desc')

// 操作类型 → 所属模块（审计日志"操作模块"字段）
const MODULE_MAP: Record<string, string> = {
  login: '认证', logout: '认证', register: '认证',
  session_connect: '分析会话',
  data_apply_create: '数据申请', data_apply_process: '数据申请', data_apply_reject: '数据申请',
  data_generate: '数据筛选与生成', data_import: '数据筛选与生成',
  export_requested: '导出审核', export_approved: '导出审核', export_rejected: '导出审核',
  result_download: '结果文件', result_download_expired: '结果文件',
  platform_test: '连接数据分析PC',
}
const moduleOf = (action: string) => MODULE_MAP[action] || '其他'

const moduleOptions = computed(() => {
  const set = [...new Set(list.value.map((x) => moduleOf(x.action)))]
  return set.map((m) => ({ label: m, value: m }))
})
const actionOptions = computed(() => [...new Set(list.value.map((x) => x.action))])

const filteredList = computed(() => {
  let rows = list.value
  if (moduleFilter.value) rows = rows.filter((x) => moduleOf(x.action) === moduleFilter.value)
  if (actionFilter.value) rows = rows.filter((x) => x.action === actionFilter.value)
  if (dateFilter.value && dateFilter.value.length === 2) {
    const [d1, d2] = dateFilter.value
    rows = rows.filter((x) => {
      const day = (x.created_at || '').slice(0, 10)
      return day >= d1 && day <= d2
    })
  }
  if (sortProp.value) {
    const dir = sortOrder.value === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) =>
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) * dir)
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

onMounted(async () => {
  loading.value = true
  try {
    list.value = await getAuditLog(500)
  } catch {
    /* 拦截器处理 */
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.page-header { align-items: center; margin-bottom: 0; }
.filter-bar { display: flex; gap: 8px; flex-wrap: wrap; }
.status-cell { display: inline-flex; align-items: center; gap: 4px; }
.pagination-wrap { margin-top: 16px; display: flex; justify-content: flex-end; }
.tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  line-height: 18px;
  background: var(--color-primary-bg);
  color: var(--color-primary);
}
</style>
