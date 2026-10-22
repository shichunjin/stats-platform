import request from './request'
import type { DataColumn } from '@/types'

/** 获取 testData 表结构（用于智能筛选） */
export function getColumns() {
  return request.get<unknown, DataColumn[]>('/data/columns')
}

/** 管理员按筛选条件生成数据文件并推送给目标用户（必须绑定数据申请）
 *  性能修复 C1：异步化——受理即返回 generating，后台生成完成后站内消息通知 */
export function generateFilteredData(params: {
  filters: Record<string, any>
  target_user_id: number
  filename?: string
  apply_id: number
}) {
  return request.post<unknown, { status: string; apply_id: number; filename: string; target_user: string; detail: string }>(
    '/data/generate',
    params,
  )
}
