<template>
  <el-card>
    <template #header>申请获取数据</template>
    <el-form ref="formRef" :model="form" :rules="rules" label-width="100px" style="max-width: 720px">
      <el-form-item label="数据用途" prop="purpose">
        <el-input v-model="form.purpose" type="textarea" :rows="3" placeholder="请描述数据用途" />
      </el-form-item>
      <el-form-item label="所需字段" prop="fields">
        <el-select v-model="form.fields" multiple filterable placeholder="选择需要的字段" style="width: 100%">
          <el-option v-for="f in fieldOptions" :key="f" :label="f" :value="f" />
        </el-select>
      </el-form-item>
      <el-form-item label="时间范围">
        <el-date-picker v-model="form.time_range" type="daterange" range-separator="至" start-placeholder="开始" end-placeholder="结束" style="width: 100%" />
      </el-form-item>
      <el-form-item label="优先级" prop="priority">
        <el-radio-group v-model="form.priority">
          <el-radio label="low">低</el-radio>
          <el-radio label="medium">中</el-radio>
          <el-radio label="high">高</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="onSubmit">提交申请</el-button>
        <el-button @click="reset">重置</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { submitApply } from '@/api/messages'

const router = useRouter()
const formRef = ref<FormInstance>()
const loading = ref(false)

const fieldOptions = ['age33', '孕妇IQ值33', 'education33', 'income33', 'sex33', 'ADHD36', 'ASD36', 'BMIPMI值33', 'GWG体重', '胎次']

const form = reactive({
  purpose: '',
  fields: [] as string[],
  time_range: [] as string[],
  priority: 'medium' as 'low' | 'medium' | 'high',
})

const rules: FormRules = {
  purpose: [{ required: true, message: '请填写数据用途', trigger: 'blur' }],
  fields: [{ required: true, message: '请选择所需字段', trigger: 'change' }],
  priority: [{ required: true, message: '请选择优先级', trigger: 'change' }],
}

async function onSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    await submitApply({
      purpose: form.purpose,
      fields: form.fields,
      time_range: form.time_range?.length ? [form.time_range[0], form.time_range[1]] : undefined,
      priority: form.priority,
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
}
</script>
