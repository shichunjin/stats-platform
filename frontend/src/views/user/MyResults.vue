<template>
  <el-card shadow="never" class="card">
    <template #header>
      <div class="page-header" style="margin:0">
        <div>
          <div class="page-header__title">我的结果文件</div>
          <div class="page-header__desc">查看已发布结果与导出申请的审核状态</div>
        </div>
        <el-button type="primary" @click="openExportDialog">
          <el-icon><Upload /></el-icon>&nbsp;申请导出结果
        </el-button>
      </div>
    </template>

    <el-alert type="info" :closable="false" class="export-guide">
      <template #title>导出流程说明</template>
      <ol class="export-guide__steps">
        <li>
          在 Windows 分析平台里，把要导出的结果文件放入桌面上的
          <b>「待导出目录」</b>快捷方式打开的文件夹
          （即 <code>\\127.0.0.1\pending\你的用户名</code>，仅本人可写），
          <b>只有放进该目录的文件才能申请导出</b>；
        </li>
        <li>回到平台本页，点击右上角「申请导出结果」，在弹出的文件列表中<b>勾选</b>需要导出的文件后提交审查；</li>
        <li>
          审查规则：与原始数据相似度低于 60% 且通过敏感信息检查的文本/图片文件
          <b>免审自动发布</b>；高相似度文件、统计软件原生格式/压缩包/文档
          （.dta/.rds/.sav/.xlsx/.zip/.pdf 等）转<b>管理员人工审核</b>；
          不允许导出的未知类型将被<b>拒绝</b>；
        </li>
        <li>审核通过后文件出现在「已发布」列表，30 天内可随时下载。</li>
      </ol>
    </el-alert>

    <el-tabs v-model="activeTab">
      <el-tab-pane name="published">
        <template #label>
          已发布（可下载）<el-badge :value="published.length" class="tab-badge" />
        </template>
        <el-table :data="published" v-loading="loading" stripe>
          <el-table-column label="文件名" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="file-cell">
                <el-icon class="file-icon"><Document /></el-icon>
                {{ row.result_name }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="110">
            <template #default="{ row }">{{ formatSize(row.file_size) }}</template>
          </el-table-column>
          <el-table-column prop="download_count" label="下载次数" width="90" />
          <el-table-column prop="created_at" label="生成时间" width="170">
            <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="有效期" width="200">
            <template #default="{ row }">
              <template v-if="row.expires_at">
                <span v-if="isExpired(row)" class="tag tag-reject">已过期</span>
                <span v-else class="validity">{{ formatTime(row.expires_at) }} 前有效</span>
              </template>
              <span v-else class="tag tag-done">永久有效</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-tooltip :disabled="!isExpired(row)" content="文件已过期，无法下载" placement="top">
                <span>
                  <el-button type="primary" link :disabled="isExpired(row)" @click="download(row)">
                    {{ isExpired(row) ? '已过期' : '下载' }}
                  </el-button>
                </span>
              </el-tooltip>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!loading && !published.length" description="暂无已发布结果，可申请导出后等待审核" />
      </el-tab-pane>

      <el-tab-pane name="pending">
        <template #label>
          导出申请<el-badge :value="pending.length" class="tab-badge" />
        </template>
        <el-table :data="pending" v-loading="loading" stripe>
          <el-table-column label="文件名" min-width="220" show-overflow-tooltip>
            <template #default="{ row }">{{ row.file_name }}</template>
          </el-table-column>
          <el-table-column prop="file_type" label="类型" width="100" />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <span class="status-cell">
                <span class="status-dot" :class="`status-dot--${statusDot(row.status)}`"></span>
                <span class="tag" :class="statusTag(row.status)">{{ statusText(row.status) }}</span>
              </span>
            </template>
          </el-table-column>
          <el-table-column label="审核说明" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.review_reason || '-' }}</template>
          </el-table-column>
          <el-table-column label="申请时间" width="170" prop="created_at">
            <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!loading && !pending.length" description="暂无导出申请" />
      </el-tab-pane>
    </el-tabs>

    <!-- 申请导出：扫描待导出目录，由用户勾选文件 -->
    <el-dialog
      v-model="exportDialogVisible"
      title="选择要导出的文件"
      width="760px"
      :close-on-click-modal="false"
    >
      <el-alert
        type="info" :closable="false" show-icon class="export-dialog__tip"
        title="以下文件来自 Windows 云桌面的「待导出目录」。勾选后提交审查；已申请过（同名同内容）的文件不可重复勾选。"
      />
      <el-table
        :data="scanFiles"
        v-loading="scanning"
        stripe
        height="360"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" :selectable="selectable" />
        <el-table-column label="文件名" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="file-cell">
              <el-icon class="file-icon"><Document /></el-icon>
              {{ row.file_name }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="100">
          <template #default="{ row }">{{ formatSize(row.file_size) }}</template>
        </el-table-column>
        <el-table-column label="修改时间" width="160">
          <template #default="{ row }">{{ formatTime(row.modified_at) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="130">
          <template #default="{ row }">
            <span v-if="row.existing_status === 'pending'" class="tag tag-pending">已申请待审核</span>
            <span v-else-if="row.existing_status === 'approved'" class="tag tag-auto">已通过</span>
            <span v-else-if="row.existing_status === 'rejected'" class="tag tag-reject">已驳回，可重提</span>
            <span v-else class="tag tag-done">可申请</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            description="待导出目录中没有文件，请先在 Windows 云桌面把结果保存到「待导出目录」"
            :image-size="70"
          />
        </template>
      </el-table>
      <template #footer>
        <span class="export-dialog__count">已选 {{ selectedFiles.length }} 个</span>
        <el-button @click="exportDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="exporting"
          :disabled="!selectedFiles.length"
          @click="submitExport"
        >提交导出申请</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Upload, Document } from '@element-plus/icons-vue'
import type { PendingFile, ExportResult } from '@/types'
import {
  getMyResults, requestExport, downloadResult, scanPendingFiles,
  type PendingScanFile,
} from '@/api/results'

const pending = ref<PendingFile[]>([])
const published = ref<ExportResult[]>([])
const loading = ref(false)
const activeTab = ref('published')

onMounted(load)

async function load() {
  loading.value = true
  try {
    const res = await getMyResults()
    pending.value = res.pending
    published.value = res.published
  } catch {
    /* 拦截器处理 */
  } finally {
    loading.value = false
  }
}

// ---- 申请导出：扫描待导出目录后由用户勾选 ----
const exportDialogVisible = ref(false)
const scanning = ref(false)
const exporting = ref(false)
const scanFiles = ref<PendingScanFile[]>([])
const selectedFiles = ref<PendingScanFile[]>([])

async function openExportDialog() {
  exportDialogVisible.value = true
  selectedFiles.value = []
  scanFiles.value = []
  scanning.value = true
  try {
    const res = await scanPendingFiles()
    scanFiles.value = res.files
  } catch {
    /* 拦截器处理 */
  } finally {
    scanning.value = false
  }
}

// 已提交过（待审核/已通过）的文件不可重复勾选；已驳回的允许重新申请
function selectable(row: PendingScanFile) {
  return !row.already_requested
}

function onSelectionChange(rows: PendingScanFile[]) {
  selectedFiles.value = rows
}

async function submitExport() {
  if (!selectedFiles.value.length) return
  exporting.value = true
  try {
    const res = await requestExport(selectedFiles.value.map(f => f.file_name))
    const parts: string[] = []
    if (res.auto_approved > 0) parts.push(`${res.auto_approved} 个文件免审核已发布，可直接下载`)
    if (res.registered > 0) parts.push(`${res.registered} 个文件需管理员审核`)
    if (res.rejected > 0) parts.push(`${res.rejected} 个文件不允许导出，已拒绝`)
    if (res.skipped.length) parts.push(`${res.skipped.length} 个文件已申请过，已跳过`)
    if (res.not_found.length) parts.push(`${res.not_found.length} 个文件已不在待导出目录`)

    if (parts.length) {
      ElMessage.success(parts.join('；'))
    } else {
      ElMessage.warning('没有新的文件被登记')
    }
    exportDialogVisible.value = false
    load()
  } catch {
    /* 拦截器处理 */
  } finally {
    exporting.value = false
  }
}

async function download(row: ExportResult) {
  if (isExpired(row)) {
    ElMessage.warning('文件已过期，无法下载')
    return
  }
  try {
    const blob = await downloadResult(row.id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = row.result_name || `result_${row.id}`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    /* 拦截器处理（过期时后端返回 410 已过期提示） */
  }
}

// 有效期判断（expires_at 为 null 表示永久有效）
function isExpired(row: ExportResult): boolean {
  if (!row.expires_at) return false
  return new Date(row.expires_at).getTime() < Date.now()
}

function formatTime(v?: string | null) {
  if (!v) return '-'
  return String(v).replace('T', ' ').slice(0, 16)
}

function formatSize(b?: number | null) {
  if (!b) return '-'
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1024 / 1024).toFixed(2) + ' MB'
}

// 状态映射
function statusTag(s: string) {
  return ({ pending: 'tag-pending', approved: 'tag-auto', rejected: 'tag-reject' } as Record<string, string>)[s] || 'tag-pending'
}
function statusDot(s: string) {
  return ({ pending: 'pending', approved: 'auto', rejected: 'reject' } as Record<string, string>)[s] || 'pending'
}
function statusText(s: string) {
  return ({ pending: '待审核', approved: '已通过', rejected: '已驳回' } as Record<string, string>)[s] || s
}
</script>

<style scoped>
.file-cell { display: inline-flex; align-items: center; gap: 8px; }
.file-icon { color: var(--text-secondary); }
.validity { font-size: 13px; color: var(--text-regular); }
.status-cell { display: inline-flex; align-items: center; gap: 4px; }
.tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--radius-full);
  font-size: var(--fs-xs);
  line-height: 18px;
}
.tab-badge { margin-left: 6px; }
.export-dialog__tip { margin-bottom: 12px; }
.export-dialog__count { float: left; line-height: 32px; font-size: var(--fs-sm); color: var(--text-secondary); }
.export-guide { margin-bottom: 16px; border-radius: var(--radius-lg); }
.export-guide__steps { margin: 6px 0 0; padding-left: 18px; }
.export-guide__steps li { margin: 4px 0; line-height: 1.7; font-size: var(--fs-sm); color: var(--text-primary); }
.export-guide__steps code {
  padding: 1px 6px;
  background: var(--color-primary-soft);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
}
</style>
