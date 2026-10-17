import request from './request'
import type { DataColumn } from '@/types'

/** 管理员导入 CSV 到数据库 */
export function importDataset() {
  return request.post<unknown, { dataset_id: number; total_rows: number; total_columns: number }>('/data/import')
}

/** 获取 testData 表结构（用于智能筛选） */
export function getColumns() {
  return request.get<unknown, DataColumn[]>('/data/columns')
}

/** 管理员按筛选条件生成数据文件并推送给目标用户（必须绑定数据申请） */
export function generateFilteredData(params: {
  filters: Record<string, any>
  target_user_id: number
  filename?: string
  apply_id: number
}) {
  return request.post<unknown, { filename: string; rows: number; columns: number; target_user: string; windows_path: string }>(
    '/data/generate',
    params,
  )
}
