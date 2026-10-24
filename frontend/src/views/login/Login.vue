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
              <el-form-item prop="confirm_password">
                <el-input
                  v-model="regForm.confirm_password"
                  type="password"
                  placeholder="请再次输入密码"
                  show-password
                  :prefix-icon="Lock"
                  size="large"
                  @keyup.enter="onRegister"
                />
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
        <router-link to="/welcome" class="welcome-link">了解平台功能介绍</router-link>
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
const regForm = reactive({ username: '', password: '', confirm_password: '', display_name: '' })

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
  confirm_password: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (_r, v, cb) => {
        v !== regForm.password ? cb(new Error('两次输入的密码不一致')) : cb()
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
  position: relative;
  overflow: hidden;
  height: 100vh;
  display: flex;
  background: transparent;
}

/* ============ 左侧：品牌展示区 ============ */
.login-left {
  flex: 0 0 52%;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 64px 56px;
  color: var(--text-title);
  background:
    radial-gradient(72% 58% at 50% -10%, #ffffff 0%, rgba(255, 255, 255, 0.68) 42%, rgba(255, 255, 255, 0) 78%),
    linear-gradient(
      160deg,
      rgba(255, 255, 255, 0.95) 0%,
      rgba(245, 248, 255, 0.9) 54%,
      rgba(237, 242, 252, 0.95) 100%
    );
  border-right: 1px solid var(--border-light);
}
/* 影棚柔光（studio lighting + global illumination） */
.login-left::before {
  content: '';
  position: absolute;
  inset: -10%;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(38% 34% at 18% 12%, rgba(150, 176, 255, 0.3), transparent 70%),
    radial-gradient(34% 32% at 88% 20%, rgba(190, 172, 255, 0.26), transparent 72%),
    radial-gradient(40% 38% at 74% 88%, rgba(150, 224, 214, 0.18), transparent 72%);
  filter: blur(50px);
}
/* 地面接触柔光 */
.login-left::after {
  content: '';
  position: absolute;
  left: 45%;
  bottom: 8%;
  z-index: 0;
  width: 340px;
  height: 92px;
  border-radius: 50%;
  background: radial-gradient(closest-side, rgba(120, 142, 190, 0.22), transparent 78%);
  filter: blur(26px);
  pointer-events: none;
}


.brand,
.brand-stats {
  position: relative;
  z-index: 2;
}
.brand-mark {
  width: 56px;
  height: 56px;
  border-radius: 18px;
  background: linear-gradient(145deg, #6b82f5 0%, #4a63f0 100%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24px;
  box-shadow: 0 14px 30px rgba(74, 99, 240, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.45), inset 0 -4px 12px rgba(30, 40, 90, 0.22);
}
.brand-name {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
  color: var(--text-title);
}
.brand-slogan {
  font-size: 15px;
  line-height: 1.7;
  color: var(--text-secondary);
  max-width: 380px;
}
.brand-stats {
  display: flex;
  gap: 44px;
  padding-top: 22px;
  border-top: 1px solid rgba(16, 24, 40, 0.07);
}
.stat-num {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-title);
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* ============ 右侧：玻璃登录卡 ============ */
.login-right {
  position: relative;
  z-index: 2;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}
.login-box {
  position: relative;
  width: 416px;
  padding: 46px 40px 40px;
  border-radius: 26px;
  background: linear-gradient(158deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 255, 255, 0.6) 100%);
  border: 1px solid rgba(255, 255, 255, 0.98);
  backdrop-filter: blur(30px) saturate(180%);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  box-shadow: 0 30px 80px -28px rgba(35, 52, 98, 0.3), 0 2px 6px rgba(23, 34, 64, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 1);
}
/* 顶部玻璃高光 */
.login-box::before {
  content: '';
  position: absolute;
  inset: 1px 1px auto;
  height: 42%;
  border-radius: 25px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0));
  pointer-events: none;
}
.title {
  position: relative;
  margin: 0;
  font-size: 27px;
  font-weight: 700;
  letter-spacing: -0.4px;
  color: var(--text-title);
}
.subtitle {
  position: relative;
  margin: 8px 0 22px;
  font-size: 13px;
  color: var(--text-secondary);
}
.tabs { position: relative; }
.login-box :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
  background: rgba(16, 24, 40, 0.07);
}
.login-box :deep(.el-tabs__item) {
  font-size: 14px;
  color: var(--text-secondary);
}
.login-box :deep(.el-tabs__item.is-active) {
  color: var(--color-primary);
  font-weight: 600;
}
.login-box :deep(.el-tabs__active-bar) {
  height: 2.5px;
  border-radius: 2px;
  background: var(--grad-primary);
}
.login-box :deep(.el-form-item) {
  margin-bottom: 20px;
}
.login-box :deep(.el-input__wrapper) {
  padding: 4px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 0 0 1px rgba(16, 24, 40, 0.07) inset, 0 1px 2px rgba(16, 24, 40, 0.03);
}
.login-box :deep(.el-input__wrapper.is-focus) {
  background: #ffffff;
  box-shadow: 0 0 0 1px var(--color-primary) inset, 0 0 0 4px rgba(74, 99, 240, 0.1);
}
.submit-btn {
  width: 100%;
  height: 46px;
  border: none;
  border-radius: 13px;
  letter-spacing: 4px;
  background: var(--grad-primary);
  box-shadow: 0 14px 30px -12px rgba(74, 99, 240, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.4);
}
.submit-btn:hover {
  background: var(--grad-primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 18px 34px -12px rgba(74, 99, 240, 0.66), inset 0 1px 0 rgba(255, 255, 255, 0.42);
}
.welcome-link {
  position: relative;
  display: block;
  margin-top: 20px;
  text-align: center;
  font-size: 13px;
  color: var(--text-secondary);
  transition: color 0.18s ease;
}
.welcome-link:hover {
  color: var(--color-primary);
}

@media (max-width: 960px) {
  .login-left { display: none; }
}
@media (max-height: 740px) {
  .login-left { padding: 44px 48px; }
  .brand-stats { padding-top: 16px; }
}
</style>
