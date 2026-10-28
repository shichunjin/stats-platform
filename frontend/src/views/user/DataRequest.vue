<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">申请获取数据</div>
          <div class="page-header__desc">填写用途与筛选条件，提交后等待管理员按条件生成并分配数据</div>
        </div>
      </div>
    </template>
    <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
      <div class="section-title">申请信息</div>
      <el-row :gutter="16">
        <el-col :span="24">
          <el-form-item label="数据用途" prop="purpose">
            <el-input v-model="form.purpose" type="textarea" :rows="3" placeholder="请描述数据用途（必填）" />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="时间范围">
            <el-date-picker
              v-model="form.time_range"
              type="daterange"
              range-separator="至"
              start-placeholder="开始"
              end-placeholder="结束"
              style="width: 100%"
            />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="优先级" prop="priority">
            <el-radio-group v-model="form.priority">
              <el-radio label="low">低</el-radio>
              <el-radio label="medium">中</el-radio>
              <el-radio label="high">高</el-radio>
            </el-radio-group>
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <div class="section-title">筛选条件（可选）</div>
    <div v-loading="colsLoading">
      <SmartFilter ref="filterRef" :columns="columns" @change="onFilterChange" />
    </div>

    <div class="action-bar">
      <el-button type="primary" :loading="loading" @click="onSubmit">提交申请</el-button>
      <el-button @click="reset">重置</el-button>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import SmartFilter from '@/components/SmartFilter.vue'
import { submitApply } from '@/api/messages'
import { getColumns } from '@/api/data'
import type { DataColumn } from '@/types'

const router = useRouter()
const formRef = ref<FormInstance>()
const filterRef = ref<InstanceType<typeof SmartFilter>>()
const loading = ref(false)

const columns = ref<DataColumn[]>([])
const colsLoading = ref(false)
const filters = ref<Record<string, any>>({})

const form = reactive({
  purpose: '',
  time_range: [] as string[],
  priority: 'medium' as 'low' | 'medium' | 'high',
})

const rules: FormRules = {
  purpose: [{ required: true, message: '请填写数据用途', trigger: 'blur' }],
  priority: [{ required: true, message: '请选择优先级', trigger: 'change' }],
}

onMounted(async () => {
  colsLoading.value = true
  try {
    columns.value = await getColumns()
  } catch {
    /* 拦截器处理 */
  } finally {
    colsLoading.value = false
  }
})

function onFilterChange(f: Record<string, any>) {
  filters.value = f
}

async function onSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    await submitApply({
      purpose: form.purpose,
      fields: [],
      time_range: form.time_range?.length ? [form.time_range[0], form.time_range[1]] : undefined,
      priority: form.priority,
      filters: filters.value,
    })
    ElMessage.success('申请已提交，等待管理员处理')
    router.push('/user/my-requests')
  } catch {
    /* 拦截器处理 */
  } finally {
    loading.value = false
  }
}

function reset() {
  formRef.value?.resetFields()
  filters.value = {}
  filterRef.value?.reset()
}
</script>

<style scoped>
.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
  margin: 8px 0 16px;
  padding-left: 8px;
  border-left: 3px solid var(--color-primary);
  line-height: 1;
}
.action-bar {
  margin-top: 20px;
  display: flex;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid var(--divider);
}
</style>
