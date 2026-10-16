<template>
  <div class="login-container">
    <div class="login-box">
      <h2 class="title">数据分析托管平台</h2>
      <el-tabs v-model="activeTab" class="tabs">
        <el-tab-pane label="登录" name="login">
          <el-form ref="loginFormRef" :model="loginForm" :rules="rules" @submit.prevent="onLogin">
            <el-form-item prop="username">
              <el-input v-model="loginForm.username" placeholder="用户名" :prefix-icon="User" size="large" />
            </el-form-item>
            <el-form-item prop="password">
              <el-input
                v-model="loginForm.password"
                type="password"
                placeholder="密码"
                show-password
                :prefix-icon="Lock"
                size="large"
                @keyup.enter="onLogin"
              />
            </el-form-item>
            <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="onLogin">
              登 录
            </el-button>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="注册" name="register">
          <el-form ref="regFormRef" :model="regForm" :rules="regRules" @submit.prevent="onRegister">
            <el-form-item prop="username">
              <el-input v-model="regForm.username" placeholder="用户名（3-20位字母/数字/._-，即云桌面账号）" :prefix-icon="User" size="large" />
            </el-form-item>
            <el-form-item prop="password">
              <el-input v-model="regForm.password" type="password" placeholder="密码（8-64位，大写/小写/数字/符号至少三类）" show-password :prefix-icon="Lock" size="large" />
            </el-form-item>
            <el-form-item prop="display_name">
              <el-input v-model="regForm.display_name" placeholder="显示名称（可选）" :prefix-icon="UserFilled" size="large" />
            </el-form-item>
            <el-button type="primary" size="large" style="width: 100%" :loading="regLoading" @click="onRegister">
              注 册
            </el-button>
          </el-form>
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { User, Lock, UserFilled } from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'
import { login as apiLogin, register as apiRegister } from '@/api/auth'
import { checkPasswordStrength } from '@/utils'

const router = useRouter()
const userStore = useUserStore()

const activeTab = ref('login')
const loading = ref(false)
const regLoading = ref(false)

const loginForm = reactive({ username: '', password: '' })
const regForm = reactive({ username: '', password: '', display_name: '' })

const loginFormRef = ref<FormInstance>()
const regFormRef = ref<FormInstance>()

const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}
const regRules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 20, message: '用户名长度 3-20', trigger: 'blur' },
    { pattern: /^[A-Za-z0-9._-]+$/, message: '仅允许字母、数字及 . _ -', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    {
      validator: (_r, v, cb) => {
        const err = checkPasswordStrength(v, regForm.username)
        err ? cb(new Error(err)) : cb()
      },
      trigger: 'blur',
    },
  ],
}

async function onLogin() {
  const valid = await loginFormRef.value?.validate().catch(() => false)
  if (!valid) return
  loading.value = true
  try {
    await userStore.login(loginForm.username, loginForm.password)
    ElMessage.success('登录成功')
    router.push('/dashboard')
  } catch {
    // 错误已由拦截器提示
  } finally {
    loading.value = false
  }
}

async function onRegister() {
  const valid = await regFormRef.value?.validate().catch(() => false)
  if (!valid) return
  regLoading.value = true
  try {
    await apiRegister(regForm.username, regForm.password, regForm.display_name)
    ElMessage.success('注册成功，请登录')
    activeTab.value = 'login'
    loginForm.username = regForm.username
  } catch {
    // 拦截器处理
  } finally {
    regLoading.value = false
  }
}
</script>

<style scoped>
.login-container {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}
.login-box {
  width: 400px;
  background: #fff;
  border-radius: 12px;
  padding: 40px 32px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}
.title {
  text-align: center;
  margin: 0 0 24px;
  font-size: 22px;
  color: #303133;
}
.tabs { margin-top: 8px; }
</style>
