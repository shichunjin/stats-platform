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

export function requestExport() {
  return request.post<unknown, {
    registered: number
    files: RequestExportItem[]
    auto_approved: number
    auto_files: RequestExportItem[]
  }>('/results/request-export')
}

export function downloadResult(id: number) {
  return request.post<unknown, Blob>(`/results/${id}/download`, {}, { responseType: 'blob' })
}
