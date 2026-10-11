<template>
  <div class="smart-filter">
    <el-form :model="model" label-width="140px" size="default">
      <el-row :gutter="16">
        <el-col v-for="col in columns" :key="col.name" :span="8">
          <el-form-item :label="col.name">
            <!-- 枚举值少 -> Select 下拉框（可搜索、可多选） -->
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

            <!-- 数值范围 -> InputNumber 区间 [min, max] -->
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
              <span class="range-sep">-</span>
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

            <!-- 文本模糊 -> Input 搜索框 -->
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
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue'
import type { DataColumn } from '@/types'

const props = defineProps<{
  columns: DataColumn[]
}>()

const emit = defineEmits<{
  (e: 'change', filters: Record<string, any>): void
}>()

// 标量值（select 数组 / input 文本）
const model = reactive<Record<string, any>>({})
// 数值区间的最小、最大值
const rangeMin = reactive<Record<string, number | undefined>>({})
const rangeMax = reactive<Record<string, number | undefined>>({})

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
  reset() {
    Object.keys(model).forEach((k) => delete model[k])
    Object.keys(rangeMin).forEach((k) => (rangeMin[k] = undefined))
    Object.keys(rangeMax).forEach((k) => (rangeMax[k] = undefined))
    emitChange()
  },
})
</script>

<style scoped>
.smart-filter { background: #fff; padding: 16px; border-radius: 4px; }
.range-box { display: flex; align-items: center; width: 100%; }
.range-sep { margin: 0 6px; color: #909399; }
</style>
