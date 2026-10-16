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

/**
 * 密码强度策略（与后端 app/auth.py 保持一致，对齐 Windows 云主机复杂度要求）：
 * 8-64 位；大写/小写/数字/特殊符号至少三类；不得包含用户名（≥3 位）。
 * 返回错误提示；通过返回空串。
 */
export function checkPasswordStrength(password: string, username?: string): string {
  if (!password || password.length < 8 || password.length > 64) return '密码长度必须为 8-64 位'
  if (/\s/.test(password)) return '密码不能包含空格'
  const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  if (categories < 3) return '需包含大写字母、小写字母、数字、特殊符号中的至少三类'
  if (username && username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    return '密码不能包含用户名'
  }
  return ''
}

