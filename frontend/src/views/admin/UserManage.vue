<template>
  <div class="page-container">
    <div class="page-header">
      <h2>用户管理</h2>
      <p class="page-desc">分配用户角色：设置 / 取消管理员。超级管理员账号只能通过服务器本地命令创建与降级，不在此页面操作。</p>
    </div>

    <el-card class="table-card" shadow="never">
      <el-table v-loading="loading" :data="users" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="username" label="用户名" min-width="130" />
        <el-table-column prop="display_name" label="显示名" min-width="120">
          <template #default="{ row }">{{ row.display_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="角色" width="130">
          <template #default="{ row }">
            <span class="status-cell">
              <i class="status-dot" :class="`status-dot--${roleDot(row.role)}`"></i>
              <span class="tag" :class="roleTag(row.role)">{{ roleText(row.role) }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.role === 'user'"
              type="primary" link size="small"
              :loading="actingId === row.id"
              @click="changeRole(row, 'admin')"
            >设为管理员</el-button>
            <el-button
              v-else-if="row.role === 'admin'"
              type="warning" link size="small"
              :loading="actingId === row.id"
              @click="changeRole(row, 'user')"
            >取消管理员</el-button>
            <el-tooltip v-else content="超级管理员账号仅能通过服务器本地命令管理" placement="left">
              <span class="op-disabled">—</span>
            </el-tooltip>
            <el-button
              v-if="row.role !== 'superadmin'"
              type="info" link size="small"
              @click="openReset(row)"
            >重置密码</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="pwdDialogVisible" title="重置用户密码" width="460px" :close-on-click-modal="false">
      <el-form ref="pwdFormRef" :model="pwdForm" :rules="pwdRules" label-width="90px">
        <el-form-item label="用户">
          <span>{{ pwdTarget?.username }}</span>
        </el-form-item>
        <el-form-item label="新密码" prop="new_password">
          <el-input
            v-model="pwdForm.new_password"
            type="password" show-password autocomplete="new-password"
            placeholder="8-64 位，大写/小写/数字/符号至少三类"
          />
        </el-form-item>
        <el-form-item label="确认密码" prop="confirm_password">
          <el-input
            v-model="pwdForm.confirm_password"
            type="password" show-password autocomplete="new-password"
            placeholder="请再次输入新密码"
            @keyup.enter="submitReset"
          />
        </el-form-item>
        <el-alert
          type="warning" :closable="false" show-icon
          title="重置后该用户需用新密码重新登录，Windows 云桌面与 Guacamole 密码将同步更新"
        />
      </el-form>
      <template #footer>
        <el-button @click="pwdDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="resetting" @click="submitReset">确认重置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { getManageUsers, updateUserRole, resetUserPassword } from '@/api/admin'
import { checkPasswordStrength } from '@/utils'
import type { User, UserRole } from '@/types'

const users = ref<User[]>([])
const loading = ref(false)
const actingId = ref<number | null>(null)

async function fetchUsers() {
  loading.value = true
  try {
    users.value = await getManageUsers()
  } finally {
    loading.value = false
  }
}

async function changeRole(row: User, target: 'user' | 'admin') {
  const actionText = target === 'admin' ? '设为管理员' : '取消管理员'
  try {
    await ElMessageBox.confirm(
      `确认将用户「${row.username}」${actionText}？变更后该用户需重新登录才能生效。`,
      '角色变更确认',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return // 用户取消
  }
  actingId.value = row.id
  try {
    await updateUserRole(row.id, target)
    ElMessage.success(`已${actionText}：${row.username}`)
    await fetchUsers()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.detail || '角色变更失败')
  } finally {
    actingId.value = null
  }
}

/* ---- 重置密码 ---- */
const pwdDialogVisible = ref(false)
const pwdTarget = ref<User | null>(null)
const pwdForm = reactive({ new_password: '', confirm_password: '' })
const pwdFormRef = ref<FormInstance>()
const resetting = ref(false)

const pwdRules: FormRules = {
  new_password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    {
      validator: (_r, v, cb) => {
        const err = checkPasswordStrength(v, pwdTarget.value?.username)
        err ? cb(new Error(err)) : cb()
      },
      trigger: 'blur',
    },
  ],
  confirm_password: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_r, v, cb) => {
        v !== pwdForm.new_password ? cb(new Error('两次输入的密码不一致')) : cb()
      },
      trigger: 'blur',
    },
  ],
}

function openReset(row: User) {
  pwdTarget.value = row
  pwdForm.new_password = ''
  pwdForm.confirm_password = ''
  pwdDialogVisible.value = true
}

async function submitReset() {
  const valid = await pwdFormRef.value?.validate().catch(() => false)
  if (!valid || !pwdTarget.value) return
  resetting.value = true
  try {
    await resetUserPassword(pwdTarget.value.id, pwdForm.new_password)
    ElMessage.success(`已重置用户 ${pwdTarget.value.username} 的密码`)
    pwdDialogVisible.value = false
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.detail || '重置密码失败')
  } finally {
    resetting.value = false
  }
}

function roleText(role: UserRole) {
  return ({ user: '普通用户', admin: '管理员', superadmin: '超级管理员' } as Record<string, string>)[role] || role
}
function roleTag(role: UserRole) {
  return ({ user: 'tag-user', admin: 'tag-admin', superadmin: 'tag-super' } as Record<string, string>)[role] || 'tag-user'
}
function roleDot(role: UserRole) {
  return ({ user: 'done', admin: 'pending', superadmin: 'reject' } as Record<string, string>)[role] || 'done'
}

onMounted(fetchUsers)
</script>

<style scoped>
.page-container { padding: 20px; }
.page-header { margin-bottom: 16px; }
.page-header h2 { margin: 0 0 6px; font-size: 20px; }
.page-desc { margin: 0; color: var(--text-secondary, #909399); font-size: 13px; }
.table-card { border-radius: 12px; }
.status-cell { display: inline-flex; align-items: center; gap: 6px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.status-dot--done { background: var(--el-color-success); }
.status-dot--pending { background: var(--el-color-warning); }
.status-dot--reject { background: var(--el-color-danger); }
.tag { font-size: 13px; font-weight: 500; }
.tag-user { color: var(--el-color-success); }
.tag-admin { color: var(--el-color-warning); }
.tag-super { color: var(--el-color-danger); }
.op-disabled { color: var(--el-text-color-placeholder); }
</style>
