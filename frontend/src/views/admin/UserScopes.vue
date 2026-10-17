<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">用户数据权限分配</div>
          <div class="page-header__desc">为用户分配所属部门与可访问的项目数据范围</div>
        </div>
      </div>
    </template>

    <el-form label-width="100px" style="max-width: 720px">
      <el-form-item label="选择用户">
        <el-select v-model="selectedUserId" @change="onUserSelect" filterable placeholder="请选择用户" style="width: 100%">
          <el-option v-for="u in users" :key="u.id" :label="`${u.display_name || u.username} (${u.username})`" :value="u.id" />
        </el-select>
      </el-form-item>

      <div class="section-title">权限配置</div>
      <el-form-item label="所属部门">
        <el-select v-model="deptId" placeholder="无" clearable style="width: 100%">
          <el-option v-for="d in depts" :key="d.id" :label="d.scope_name" :value="d.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="项目范围">
        <el-checkbox-group v-model="scopeIds">
          <el-checkbox v-for="p in projects" :key="p.id" :value="p.id" border>{{ p.scope_name }}</el-checkbox>
        </el-checkbox-group>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存权限</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { User, Scope } from '@/types'
import { getUsers, getScopes, updateUserScopes } from '@/api/admin'

const users = ref<User[]>([])
const scopes = ref<Scope[]>([])
const selectedUserId = ref<number | undefined>()
const deptId = ref<number | undefined>()
const scopeIds = ref<number[]>([])
const saving = ref(false)

const depts = computed(() => scopes.value.filter((s) => s.scope_type === 'dept'))
const projects = computed(() => scopes.value.filter((s) => s.scope_type === 'project'))

onMounted(async () => {
  try {
    const [u, s] = await Promise.all([getUsers(), getScopes()])
    users.value = u
    scopes.value = s
  } catch {
    /* 拦截器处理 */
  }
})

function onUserSelect(uid: number) {
  const u = users.value.find((x) => x.id === uid)
  deptId.value = u?.dept?.id
  scopeIds.value = (u?.scopes || []).map((s) => s.id)
}

async function save() {
  if (!selectedUserId.value) {
    ElMessage.warning('请先选择用户')
    return
  }
  saving.value = true
  try {
    await updateUserScopes(selectedUserId.value, deptId.value || null, scopeIds.value)
    ElMessage.success('数据权限已更新')
  } catch {
    /* 拦截器处理 */
  } finally {
    saving.value = false
  }
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
</style>
