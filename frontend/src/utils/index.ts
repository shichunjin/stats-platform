/** 格式化文件大小 */
export function formatSize(b?: number | null): string {
  if (!b) return '-'
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  return (b / 1024 / 1024).toFixed(2) + ' MB'
}

/** 格式化日期 */
export function formatDate(s?: string | null): string {
  if (!s) return '-'
  return new Date(s).toLocaleString('zh-CN')
}

/** 生成带时间戳的文件名：{name}_{YYYYMMDD_HHmmss}.{ext} */
export function timestampFilename(name: string, ext = 'xlsx'): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${name}_${ts}.${ext}`
}
