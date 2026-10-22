<template>
  <div class="smart-filter">
    <!-- 工具栏：搜索 + 已选计数 + 清空 -->
    <div class="filter-toolbar">
      <div class="toolbar-left">
        <el-input
          v-model="keyword"
          placeholder="搜索筛选条件名称，快速定位"
          clearable
          :prefix-icon="Search"
          style="width: 260px"
        />
        <span class="toolbar-tip">共 {{ columns.length }} 个条件，默认展示前 {{ VISIBLE_LIMIT }} 个</span>
      </div>
      <div class="toolbar-right">
        <el-badge :value="selectedCount" class="selected-badge">
          <span class="selected-text">已选条件</span>
        </el-badge>
        <el-button link type="primary" size="small" :disabled="!selectedCount" @click="resetAll">清空</el-button>
      </div>
    </div>

    <el-form :model="model" label-width="140px" size="default">
      <!-- 默认展示：前 20 个（或搜索命中）条件 -->
      <el-row :gutter="16">
        <el-col v-for="col in visibleColumns" :key="col.name" :span="8">
          <el-form-item>
            <template #label>
              <span class="field-label">
                <span class="field-name">{{ col.name }}</span>
                <span class="field-type" :class="`field-type--${col.control}`">{{ typeLabel(col.control) }}</span>
              </span>
            </template>
            <!-- 枚举字段 -> Select 下拉框（可搜索、可多选） -->
            <el-select
              v-if="col.control === 'select'"
              v-model="model[col.name]"
              placeholder="请选择"
              filterable
              clearable
              multiple
              collapse-tags
              collapse-tags-tooltip
              style="width: 100%"
              @change="emitChange"
            >
              <el-option
                v-for="opt in col.options"
                :key="opt"
                :label="String(opt)"
                :value="opt"
              />
            </el-select>

            <!-- 数值字段 -> 区间输入 [min, max] -->
            <div v-else-if="col.control === 'range'" class="range-box">
              <el-input-number
                v-model="rangeMin[col.name]"
                :min="col.min"
                :max="col.max"
                placeholder="最小"
                controls-position="right"
                style="width: 50%"
                @change="onRangeChange(col.name)"
              />
              <span class="range-sep">—</span>
              <el-input-number
                v-model="rangeMax[col.name]"
                :min="col.min"
                :max="col.max"
                placeholder="最大"
                controls-position="right"
                style="width: 50%"
                @change="onRangeChange(col.name)"
              />
            </div>

            <!-- 日期字段 -> 日期范围选择 -->
            <el-date-picker
              v-else-if="col.control === 'daterange'"
              v-model="dateRange[col.name]"
              type="daterange"
              value-format="YYYY-MM-DD"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              style="width: 100%"
              @change="onDateChange(col.name)"
            />

            <!-- 文本字段 -> 模糊搜索输入框 -->
            <el-input
              v-else
              v-model="model[col.name]"
              placeholder="请输入关键词"
              clearable
              @input="emitChange"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <!-- 更多筛选条件：显眼的大号展开/收起按钮 -->
      <div v-if="moreColumns.length" class="more-toggle-wrap">
        <el-button type="primary" plain size="large" class="more-toggle" @click="toggleMore">
          {{ expanded ? '收起更多筛选条件' : `展开更多筛选条件（${moreColumns.length}）` }}
          <el-icon style="margin-left: 4px">
            <ArrowDown v-if="!expanded" />
            <ArrowUp v-else />
          </el-icon>
        </el-button>
      </div>

      <template v-if="moreColumns.length && expanded">
        <el-divider content-position="left">更多筛选条件</el-divider>
        <el-row :gutter="16">
          <el-col v-for="col in moreColumns" :key="col.name" :span="8">
            <el-form-item>
              <template #label>
                <span class="field-label">
                  <span class="field-name">{{ col.name }}</span>
                  <span class="field-type" :class="`field-type--${col.control}`">{{ typeLabel(col.control) }}</span>
                </span>
              </template>
              <el-select
                v-if="col.control === 'select'"
                v-model="model[col.name]"
                placeholder="请选择"
                filterable
                clearable
                multiple
                collapse-tags
                collapse-tags-tooltip
                style="width: 100%"
                @change="emitChange"
              >
                <el-option v-for="opt in col.options" :key="opt" :label="String(opt)" :value="opt" />
              </el-select>

              <div v-else-if="col.control === 'range'" class="range-box">
                <el-input-number
                  v-model="rangeMin[col.name]"
                  :min="col.min"
                  :max="col.max"
                  placeholder="最小"
                  controls-position="right"
                  style="width: 50%"
                  @change="onRangeChange(col.name)"
                />
                <span class="range-sep">—</span>
                <el-input-number
                  v-model="rangeMax[col.name]"
                  :min="col.min"
                  :max="col.max"
                  placeholder="最大"
                  controls-position="right"
                  style="width: 50%"
                  @change="onRangeChange(col.name)"
                />
              </div>

              <el-date-picker
                v-else-if="col.control === 'daterange'"
                v-model="dateRange[col.name]"
                type="daterange"
                value-format="YYYY-MM-DD"
                start-placeholder="开始日期"
                end-placeholder="结束日期"
                style="width: 100%"
                @change="onDateChange(col.name)"
              />

              <el-input
                v-else
                v-model="model[col.name]"
                placeholder="请输入关键词"
                clearable
                @input="emitChange"
              />
            </el-form-item>
          </el-col>
        </el-row>
      </template>
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Search, ArrowDown, ArrowUp } from '@element-plus/icons-vue'
import type { DataColumn } from '@/types'

const props = defineProps<{
  columns: DataColumn[]
}>()

const emit = defineEmits<{
  (e: 'change', filters: Record<string, any>): void
}>()

// 约束：筛选条件过多时默认只展示前 20 个，其余折叠
const VISIBLE_LIMIT = 20

// 标量值（select 数组 / input 文本）
const model = reactive<Record<string, any>>({})
// 数值区间的最小、最大值
const rangeMin = reactive<Record<string, number | undefined>>({})
const rangeMax = reactive<Record<string, number | undefined>>({})
// 日期区间 [start, end]
const dateRange = reactive<Record<string, [string, string] | null>>({})

const keyword = ref('')
const expanded = ref(false)

// 按关键词过滤后的列（名称模糊匹配）
const matchedColumns = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return props.columns
  return props.columns.filter((c) => c.name.toLowerCase().includes(kw))
})

// 搜索时在全部命中里取前 20，未搜索时取原始顺序前 20
const visibleColumns = computed(() => matchedColumns.value.slice(0, VISIBLE_LIMIT))
const moreColumns = computed(() => matchedColumns.value.slice(VISIBLE_LIMIT))

function toggleMore() {
  expanded.value = !expanded.value
}

// 字段类型标签
function typeLabel(control: string): string {
  return ({ select: '枚举', range: '数值', daterange: '日期' } as Record<string, string>)[control] || '文本'
}

// 已选条件数（排除空值）
const selectedCount = computed(() =>
  Object.values(model).filter((v) => {
    if (v === undefined || v === null || v === '') return false
    if (Array.isArray(v) && v.length === 0) return false
    return true
  }).length,
)

function resetAll() {
  Object.keys(model).forEach((k) => delete model[k])
  Object.keys(rangeMin).forEach((k) => (rangeMin[k] = undefined))
  Object.keys(rangeMax).forEach((k) => (rangeMax[k] = undefined))
  Object.keys(dateRange).forEach((k) => (dateRange[k] = null))
  keyword.value = ''
  expanded.value = false
  emitChange()
}

function onRangeChange(name: string) {
  const lo = rangeMin[name]
  const hi = rangeMax[name]
  if (lo === undefined && hi === undefined) {
    delete model[name]
  } else {
    model[name] = [lo ?? null, hi ?? null]
  }
  emitChange()
}

function onDateChange(name: string) {
  const v = dateRange[name]
  if (v && v.length === 2) {
    model[name] = v
  } else {
    delete model[name]
  }
  emitChange()
}

function emitChange() {
  const filters: Record<string, any> = {}
  Object.keys(model).forEach((k) => {
    const v = model[k]
    if (v === undefined || v === null || v === '') return
    // 空数组（多选未选）不提交
    if (Array.isArray(v) && v.length === 0) return
    filters[k] = v
  })
  emit('change', filters)
}

watch(model, emitChange, { deep: true })

// 暴露给父组件：取筛选条件 / 重置
defineExpose({
  getFilters: () => model,
  reset: resetAll,
})
</script>

<style scoped>
.smart-filter {
  background: var(--bg-surface);
  padding: 20px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-light);
}
.filter-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px dashed var(--border-light);
  flex-wrap: wrap;
  gap: 12px;
}
.toolbar-left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.toolbar-right { display: flex; align-items: center; gap: 12px; }
.toolbar-tip { font-size: 12px; color: var(--text-secondary); }
.selected-badge { margin-right: 4px; }
.selected-text { font-size: 13px; color: var(--text-regular); }

.field-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.field-name { color: var(--text-regular); }
.field-type {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  line-height: 16px;
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.field-type--select { background: rgba(47, 99, 255, 0.1); color: var(--color-primary); }
.field-type--range { background: rgba(16, 185, 129, 0.1); color: var(--status-done); }
.field-type--daterange { background: rgba(245, 158, 11, 0.1); color: var(--status-pending); }

.range-box {
  display: flex;
  align-items: center;
  width: 100%;
  background: var(--bg-hover);
  padding: 4px 8px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
}
.range-sep { margin: 0 6px; color: var(--text-placeholder); }
.more-toggle-wrap {
  display: flex;
  justify-content: center;
  padding: 16px 0 4px;
}
.more-toggle {
  min-width: 280px;
  font-size: 14px;
}
</style>
