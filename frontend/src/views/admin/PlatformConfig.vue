<template>
  <el-card>
    <template #header>连接 Windows 分析平台配置</template>
    <el-form ref="formRef" :model="form" :rules="rules" label-width="120px" style="max-width: 600px">
      <el-form-item label="平台地址" prop="host">
        <el-input v-model="form.host" placeholder="如 8.133.223.251" />
      </el-form-item>
      <el-form-item label="端口" prop="port">
        <el-input-number v-model="form.port" :min="1" :max="65535" style="width: 100%" />
      </el-form-item>
      <el-form-item label="用户名" prop="username">
        <el-input v-model="form.username" placeholder="Administrator" />
      </el-form-item>
      <el-form-item label="密码" prop="password">
        <el-input v-model="form.password" type="password" show-password placeholder="登录密码" />
      </el-form-item>
      <el-form-item label="默认输出路径" prop="output_path">
        <el-input v-model="form.output_path" placeholder="C:\StatsData" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="testing" @click="test">测试连接</el-button>
        <el-button type="success" @click="save">保存配置</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import type { PlatformConfig } from '@/types'

const formRef = ref<FormInstance>()
const testing = ref(false)

const form = reactive<PlatformConfig>({
  host: '8.133.223.251',
  port: 22,
  username: 'Administrator',
  password: '',
  output_path: 'C:\\StatsData',
})

const rules: FormRules = {
  host: [{ required: true, message: '请输入平台地址', trigger: 'blur' }],
  port: [{ required: true, message: '请输入端口', trigger: 'blur' }],
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

async function test() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  testing.value = true
  // 模拟测试连接（实际应调用后端 /admin/platform/test）
  setTimeout(() => {
    testing.value = false
    ElMessage.success(`连接成功：${form.host}:${form.port}`)
  }, 1200)
}

function save() {
  ElMessage.success('配置已保存')
  localStorage.setItem('platform_config', JSON.stringify(form))
}
</script>
