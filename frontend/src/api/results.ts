import request from './request'
import type { PendingFile, ExportResult } from '@/types'

export function getMyResults() {
  return request.get<unknown, { pending: PendingFile[]; published: ExportResult[] }>('/results/mine')
}

export function requestExport() {
  return request.post<unknown, { registered: number }>('/results/request-export')
}

export function downloadResult(id: number) {
  return request.post<unknown, Blob>(`/results/${id}/download`, {}, { responseType: 'blob' })
}
