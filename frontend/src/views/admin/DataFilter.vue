<template>
  <div class="data-filter">
    <el-card shadow="never" class="card">
      <template #header>
        <div class="page-header" style="margin:0">
          <div>
            <div class="page-header__title">
              数据筛选与生成
              <el-tag v-if="applyId" type="warning" size="small" style="margin-left:8px">申请ID: {{ applyId }}</el-tag>
            </div>
            <div class="page-header__desc">设置筛选条件，生成数据并推送给指定用户的工作空间</div>
          </div>
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
              <el-input v-model="filename" placeholder="留空则自动命名 testData_时间戳.xlsx" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <!-- 智能筛选控件 -->
      <div v-loading="colsLoading">
        <SmartFilter
          ref="filterRef"
          :columns="columns"
          :initial-filters="presetFilters"
          :focus-columns="presetColumns"
          @change="onFilterChange"
        />
      </div>

      <el-alert
        v-if="presetCount"
        type="info"
        :closable="false"
        show-icon
        style="margin-top: 16px"
        :title="`已自动带入用户申请中填写的 ${presetCount} 项筛选条件`"
        description="如需追加条件，点击上方「展开更多筛选条件」手动补充；生成时将以当前全部条件为准"
      />

      <el-alert v-if="!applyId" type="warning" :closable="false" show-icon style="margin-top: 16px"
                title="未关联数据申请：请从「待处理申请」页面点击「筛选生成」进入本页，生成数据必须绑定用户申请" />

      <div class="action-bar">
        <el-button type="primary" size="large" :loading="generating" @click="generate">
          <el-icon><Check /></el-icon>&nbsp;确认生成并推送给用户
        </el-button>
        <el-button size="large" @click="resetFilters">重置筛选</el-button>
      </div>

      <el-alert v-if="lastResult" :title="`已受理，后台生成中：${lastResult.filename}`"
                description="生成完成后用户将收到站内消息；失败可在「待处理申请」查看原因并重试"
                type="success" :closable="false" style="margin-top: 16px" />
    </el-card>

    <!-- 错误日志 -->
    <el-card shadow="never" class="card" style="margin-top: 16px" v-if="errorLog.length">
      <template #header>
        <div class="page-header" style="margin:0">
          <div>
            <div class="page-header__title" style="font-size:16px">生成失败日志</div>
          </div>
        </div>
      </template>
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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import SmartFilter from '@/components/SmartFilter.vue'
import { getColumns, generateFilteredData } from '@/api/data'
import { getUsers, getDataApply } from '@/api/admin'
import type { DataColumn, User } from '@/types'

const route = useRoute()
// 同组件内切换申请（仅 query 变化）不会重新挂载，需按 query 变化重新加载
const applyId = computed(() => route.query.applyId as string | undefined)

const columns = ref<DataColumn[]>([])
const colsLoading = ref(false)
const users = ref<User[]>([])
const targetUserId = ref<number | undefined>(Number(route.query.userId) || undefined)
const filename = ref('')
const generating = ref(false)
const filters = ref<Record<string, any>>({})
const lastResult = ref<{ filename: string } | null>(null)
const errorLog = ref<{ time: string; message: string }[]>([])

// 申请中用户填写的筛选条件（进入页面时自动带入，主区域仅展示这些条件）
const presetFilters = ref<Record<string, any>>({})
const presetColumns = computed(() => Object.keys(presetFilters.value))
const presetCount = computed(() => presetColumns.value.length)

const filterRef = ref<InstanceType<typeof SmartFilter>>()

// 防止快速切换申请时旧请求覆盖新申请的筛选条件
let presetSeq = 0

async function loadPreset(id?: string) {
  const seq = ++presetSeq
  presetFilters.value = {}
  if (!id) return
  try {
    const apply = await getDataApply(Number(id))
    if (seq !== presetSeq) return
    presetFilters.value = apply.filters || {}
  } catch {
    /* 拦截器处理 */
  }
}

watch(
  () => route.query,
  () => {
    // 切换申请时重置目标用户、文件名与生成结果，避免沿用上一条申请的状态
    targetUserId.value = Number(route.query.userId) || undefined
    filename.value = ''
    lastResult.value = null
    loadPreset(applyId.value)
  },
)

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
  // 从「待处理申请」进入时，带入用户提交的筛选条件
  await loadPreset(applyId.value)
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

    // 性能修复 C1：生成已异步化——接口受理（置 generating）后立即返回，
    // 后台执行 Excel 生成 + SFTP 推送，完成后站内消息通知用户
    const res = await generateFilteredData({
      filters: filters.value,
      target_user_id: targetUserId.value,
      filename: finalName,
      apply_id: Number(applyId.value),
    })
    lastResult.value = { filename: res.filename }
    ElMessage.success(res.detail || `已受理，后台生成中：${res.filename}`)
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

<style scoped>
.action-bar {
  margin-top: 20px;
  display: flex;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--divider);
}
</style>
