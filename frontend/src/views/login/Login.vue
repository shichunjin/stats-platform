<template>
  <div class="login-container">
    <div class="login-left">
      <div class="brand">
        <div class="brand-mark">
          <el-icon :size="28"><DataLine /></el-icon>
        </div>
        <div class="brand-name">数据分析托管平台</div>
        <div class="brand-slogan">安全、合规、可追溯的临床研究数据协作空间</div>
      </div>
      <div class="brand-stats">
        <div class="stat-item">
          <div class="stat-num">200+</div>
          <div class="stat-label">研究队列</div>
        </div>
        <div class="stat-item">
          <div class="stat-num">全链路</div>
          <div class="stat-label">操作审计</div>
        </div>
        <div class="stat-item">
          <div class="stat-num">W / Z</div>
          <div class="stat-label">隔离工作空间</div>
        </div>
      </div>
    </div>

    <div class="login-right">
      <div class="login-box">
        <h2 class="title">{{ activeTab === 'login' ? '欢迎回来' : '创建账号' }}</h2>
        <p class="subtitle">{{ activeTab === 'login' ? '登录以继续使用数据托管服务' : '注册后可申请数据与导出结果' }}</p>
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
              <el-button type="primary" size="large" class="submit-btn" :loading="loading" @click="onLogin">
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
              <el-button type="primary" size="large" class="submit-btn" :loading="regLoading" @click="onRegister">
                注 册
              </el-button>
            </el-form>
          </el-tab-pane>
        </el-tabs>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { User, Lock, UserFilled, DataLine } from '@element-plus/icons-vue'
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
  background: var(--bg-app);
}

/* 左侧品牌区 */
.login-left {
  flex: 0 0 52%;
  background: linear-gradient(135deg, #0b1220 0%, #1e3a8a 55%, #2f63ff 100%);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 64px 56px;
  color: #fff;
}
.login-left::before {
  content: '';
  position: absolute;
  top: -120px;
  right: -120px;
  width: 420px;
  height: 420px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.45), transparent 70%);
}
.login-left::after {
  content: '';
  position: absolute;
  bottom: -160px;
  left: -80px;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(47, 99, 255, 0.35), transparent 70%);
}
.brand { position: relative; z-index: 1; }
.brand-mark {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.14);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24px;
  backdrop-filter: blur(6px);
}
.brand-name {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 1px;
  margin-bottom: 12px;
}
.brand-slogan {
  font-size: 15px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.78);
  max-width: 380px;
}
.brand-stats {
  position: relative;
  z-index: 1;
  display: flex;
  gap: 40px;
}
.stat-num {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  margin-top: 4px;
}

/* 右侧表单区 */
.login-right {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}
.login-box {
  width: 420px;
  background: #fff;
  border-radius: 16px;
  padding: 44px 36px;
  box-shadow: var(--shadow-lg);
}
.title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  color: var(--text-title);
}
.subtitle {
  margin: 8px 0 24px;
  font-size: 13px;
  color: var(--text-secondary);
}
.tabs { margin-top: 8px; }
.submit-btn {
  width: 100%;
  background: linear-gradient(135deg, #2f63ff, #5b7bff);
  border: none;
  letter-spacing: 4px;
}
.submit-btn:hover {
  background: linear-gradient(135deg, #1f4fe6, #4a6bff);
}

@media (max-width: 960px) {
  .login-left { display: none; }
}
</style>
