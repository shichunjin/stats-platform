import request from './request'
import type { PendingFile, ExportResult } from '@/types'

export function getMyResults() {
  return request.get<unknown, { pending: PendingFile[]; published: ExportResult[] }>('/results/mine')
}

export interface RequestExportItem {
  id: number
  file_name: string
  status: string
  reason?: string
  result_id?: number
}

// 待导出目录扫描结果
export interface PendingScanFile {
  file_name: string
  file_size: number
  modified_at?: string | null
  file_type?: string | null
  already_requested: boolean
  existing_status?: 'pending' | 'approved' | 'rejected' | null
}

export function scanPendingFiles() {
  return request.get<unknown, { files: PendingScanFile[] }>('/results/pending-files')
}

export function requestExport(fileNames: string[]) {
  return request.post<unknown, {
    registered: number
    files: RequestExportItem[]
    auto_approved: number
    auto_files: RequestExportItem[]
    rejected: number
    rejected_files: RequestExportItem[]
    skipped: string[]
    not_found: string[]
  }>('/results/request-export', { file_names: fileNames })
}

export function downloadResult(id: number) {
  return request.post<unknown, Blob>(`/results/${id}/download`, {}, { responseType: 'blob' })
}
