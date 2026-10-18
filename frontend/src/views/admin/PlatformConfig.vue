<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">连接数据分析 PC</div>
          <div class="page-header__desc">配置 Windows 数据分析主机的连接信息与数据投递目录</div>
        </div>
      </div>
    </template>

    <!-- 连接状态：已连接 / 连接中 / 连接失败 -->
    <el-alert
      v-if="connState !== 'idle'"
      :title="connStateText"
      :type="connState === 'connected' ? 'success' : connState === 'connecting' ? 'info' : 'error'"
      :description="connError || undefined"
      :closable="connState !== 'connecting'"
      show-icon
      style="margin-bottom: 16px"
    />

    <el-form ref="formRef" :model="form" :rules="rules" label-width="120px" style="max-width: 640px">
      <div class="section-title">连接信息</div>
      <el-form-item label="PC地址" prop="host">
        <el-input v-model="form.host" placeholder="Windows 数据分析主机地址（IP 或主机名）" />
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

      <div class="section-title">数据投递目录</div>
      <el-form-item label="工作目录" prop="workspace_dir">
        <el-input v-model="form.workspace_dir" placeholder="C:\workspace（各用户私有目录的父目录）" />
        <div class="field-tip">按申请生成数据时，将写入该目录下以用户名命名的子目录（对应用户 W: 盘）</div>
      </el-form-item>
      <el-form-item label="输出目录" prop="output_path">
        <el-input v-model="form.output_path" placeholder="C:\StatsData（公共数据目录，对应用户 Z: 盘）" />
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="testing" @click="test">测试连接</el-button>
        <el-button type="success" :loading="saving" @click="save">保存配置</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { testPlatform, getPlatformConfig, savePlatformConfig } from '@/api/admin'
import type { PlatformConfig } from '@/types'

const formRef = ref<FormInstance>()
const testing = ref(false)
const saving = ref(false)

// 连接状态：idle 未测 / connecting 连接中 / connected 已连接 / failed 连接失败
const connState = ref<'idle' | 'connecting' | 'connected' | 'failed'>('idle')
const connError = ref('')
const connStateText = ref('')

const form = reactive<PlatformConfig>({
  host: '',
  port: 22,
  username: 'Administrator',
  password: '',
  workspace_dir: 'C:\\workspace',
  output_path: 'C:\\StatsData',
})

const rules: FormRules = {
  host: [{ required: true, message: '请输入PC地址', trigger: 'blur' }],
  port: [{ required: true, message: '请输入端口', trigger: 'blur' }],
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

onMounted(async () => {
  // 安全修复 C4：配置从后端平台配置库读取（库 > 环境变量兜底），密码永不返回
  try {
    const cfg = await getPlatformConfig()
    Object.assign(form, cfg, { password: '' })
  } catch {
    /* 拦截器处理 */
  }
})

// 测试连接：调用后端真实 SSH 连通性检测，失败时后端返回具体错误信息
async function test() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  testing.value = true
  connState.value = 'connecting'
  connStateText.value = `正在连接 ${form.host}:${form.port} ...`
  connError.value = ''
  try {
    const res = await testPlatform({
      host: form.host,
      port: form.port,
      username: form.username,
      password: form.password,
    })
    connState.value = 'connected'
    connStateText.value = `已连接：${res.message}`
    ElMessage.success(res.message)
  } catch (e: any) {
    connState.value = 'failed'
    connError.value = e?.response?.data?.detail || e.message || '未知错误'
    connStateText.value = '连接失败'
  } finally {
    testing.value = false
  }
}

// 保存配置：落库到后端平台配置表（安全修复 C4），保存即生效；
// 密码不传输、不落库——仅测试连接时临时使用
async function save() {
  saving.value = true
  try {
    const res = await savePlatformConfig({
      host: form.host,
      port: form.port,
      username: form.username,
      workspace_dir: form.workspace_dir,
      output_path: form.output_path,
    })
    ElMessage.success(res.message || '配置已保存并生效（已写入后端）')
  } catch {
    /* 拦截器处理 */
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.field-tip {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-top: 4px;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
  margin: 8px 0 16px;
  padding-left: 8px;
  border-left: 3px solid var(--color-primary);
  line-height: 1;
}
</style>
