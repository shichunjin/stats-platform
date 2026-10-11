<template>
  <div class="data-filter">
    <el-card>
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span>数据筛选与生成</span>
          <el-tag v-if="applyId">申请ID: {{ applyId }}</el-tag>
        </div>
      </template>

      <!-- 目标用户选择 -->
      <el-form label-width="120px" style="margin-bottom: 16px">
        <el-row :gutter="16">
          <el-col :span="8">
            <el-form-item label="目标用户">
              <el-select v-model="targetUserId" placeholder="选择接收数据的用户" filterable style="width: 100%">
                <el-option v-for="u in users" :key="u.id" :label="u.display_name || u.username" :value="u.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="文件名">
              <el-input v-model="filename" placeholder="留空则自动命名" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <!-- 智能筛选控件 -->
      <div v-loading="colsLoading">
        <SmartFilter ref="filterRef" :columns="columns" @change="onFilterChange" />
      </div>

      <div style="margin-top: 16px; display: flex; gap: 12px">
        <el-button type="primary" :loading="generating" @click="generate">
          <el-icon><Check /></el-icon>&nbsp;确认生成并推送给用户
        </el-button>
        <el-button @click="resetFilters">重置筛选</el-button>
      </div>

      <el-alert v-if="lastResult" :title="`已生成：${lastResult.filename}（${lastResult.rows} 行）`" type="success" :closable="false" style="margin-top: 16px" />
    </el-card>

    <!-- 错误日志 -->
    <el-card style="margin-top: 16px" v-if="errorLog.length">
      <template #header>生成失败日志</template>
      <el-table :data="errorLog" size="small">
        <el-table-column prop="time" label="时间" width="170" />
        <el-table-column prop="message" label="错误信息" />
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button link type="primary" @click="retry(row)">重试</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import SmartFilter from '@/components/SmartFilter.vue'
import { getColumns, generateFilteredData } from '@/api/data'
import { getUsers } from '@/api/admin'
import type { DataColumn } from '@/types'

const route = useRoute()
const applyId = route.query.applyId as string | undefined

const columns = ref<DataColumn[]>([])
const colsLoading = ref(false)
const users = ref<{ id: number; username: string; display_name?: string }[]>([])
const targetUserId = ref<number | undefined>(Number(route.query.userId) || undefined)
const filename = ref('')
const generating = ref(false)
const filters = ref<Record<string, any>>({})
const lastResult = ref<{ filename: string; rows: number } | null>(null)
const errorLog = ref<{ time: string; message: string }[]>([])

const filterRef = ref<InstanceType<typeof SmartFilter>>()

onMounted(async () => {
  colsLoading.value = true
  try {
    columns.value = await getColumns()
  } catch {
    /* 拦截器处理 */
  } finally {
    colsLoading.value = false
  }
  try {
    users.value = await getUsers()
  } catch {
    /* 拦截器处理 */
  }
})

function onFilterChange(f: Record<string, any>) {
  filters.value = f
}

function resetFilters() {
  filters.value = {}
  filterRef.value?.reset()
  lastResult.value = null
}

async function generate() {
  if (!targetUserId.value) {
    ElMessage.warning('请先选择目标用户')
    return
  }
  generating.value = true
  lastResult.value = null
  try {
    // 文件命名规则：{原始名}_{YYYYMMDD_HHmmss}.ext
    const now = new Date()
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const finalName = filename.value || `testData_${ts}.xlsx`

    const res = await generateFilteredData({
      filters: filters.value,
      target_user_id: targetUserId.value,
      filename: finalName,
      apply_id: applyId ? Number(applyId) : undefined,
    })
    lastResult.value = { filename: res.filename, rows: res.rows }
    ElMessage.success(`数据已生成并推送给用户：${res.filename}（${res.rows} 行）`)
  } catch (e: any) {
    errorLog.value.unshift({
      time: new Date().toLocaleString(),
      message: e?.response?.data?.detail || e.message || '生成失败',
    })
  } finally {
    generating.value = false
  }
}

function retry(row: { message: string }) {
  ElMessage.info('重新生成中...')
  generate()
}
</script>
