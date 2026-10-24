import type { MockMethod } from 'vite-plugin-mock'

const now = new Date().toISOString()

const mockUser = {
  id: 1,
  username: 'admin',
  display_name: '管理员',
  role: 'admin',
  dept: null,
  scopes: [
    { id: 1, scope_code: 'dept_1', scope_type: 'dept', scope_name: '统计学院', data_path: '/data/dept_1' },
  ],
}

// testData 智能筛选列结构（模拟后端 /data/columns）
// 生成 25 列以便联调"前 20 条默认展示 + 更多折叠"逻辑
const mockColumns = [
  { name: 'sex33', type: 'int', control: 'select', options: [1, 2] },
  { name: 'education33', type: 'int', control: 'select', options: [1, 2, 3, 4, 5] },
  { name: 'age33', type: 'int', control: 'range', min: 0, max: 120 },
  { name: '孕妇IQ值33', type: 'float', control: 'range', min: 0, max: 200 },
  { name: 'income33', type: 'int', control: 'range', min: 0, max: 1000000 },
  { name: '姓名', type: 'text', control: 'input' },
  { name: '出生日期', type: 'date', control: 'daterange', min: '2015-01-01', max: '2020-12-31' },
  { name: '喂养方式33', type: 'int', control: 'select', options: [1, 2, 3, 4] },
  { name: 'ADHD36', type: 'int', control: 'select', options: [0, 1] },
  { name: 'ASD36', type: 'int', control: 'select', options: [0, 1] },
  ...Array.from({ length: 15 }, (_, i) => ({
    name: `扩展字段${i + 1}`,
    type: 'text' as const,
    control: 'input' as const,
  })),
]

const mockApplies = [
  { id: 1001, data_name: 'testData', purpose: '硕士论文研究', fields: ['age33', 'ADHD36'], time_range: null, priority: 'high', status: 'pending', apply_time: now, target_user_id: 2, username: 'student1', display_name: '张同学' },
  { id: 1002, data_name: 'testData', purpose: '课题数据分析', fields: ['sex33', 'education33'], priority: 'medium', status: 'processing', apply_time: now, target_user_id: 3, username: 'student2', display_name: '李同学' },
  { id: 1003, data_name: 'testData', purpose: '课程作业', fields: ['age33'], priority: 'low', status: 'completed', apply_time: now, finish_time: now, target_user_id: 2, username: 'student1', display_name: '张同学' },
  { id: 1004, data_name: 'testData', purpose: '探索性分析', fields: ['BMI值33'], priority: 'low', status: 'rejected', reject_reason: '字段选择过少', apply_time: now, target_user_id: 3, username: 'student2', display_name: '李同学' },
]

const mockMessages = [
  { id: 1, title: '数据申请已通过', content: '您的申请 #1003 已处理完成，结果已推送到 Windows 平台', type: 'success', read: false, created_at: now, link: '/user/my-results' },
  { id: 2, title: '导出申请已审核', content: '您的导出申请 result_45.csv 已通过审核，可在结果文件中下载', type: 'success', read: true, created_at: now, link: '/user/my-results' },
]

const pendingFiles = [
  { id: 1, file_name: 'result_analysis.csv', file_type: 'csv', status: 'pending', review_reason: null, created_at: now },
]

const publishedFiles = [
  { id: 1, result_name: 'result_analysis.csv', file_size: 20480, download_count: 3, expires_at: null, created_at: now },
  { id: 2, result_name: 'chart.png', file_size: 102400, download_count: 1, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), created_at: now },
  { id: 3, result_name: 'old_result.csv', file_size: 5120, download_count: 0, expires_at: new Date(Date.now() - 86400000).toISOString(), created_at: now },
]

const auditLogs = [
  { id: 1, user_id: 1, action: 'login', detail: '管理员登录', ip_addr: '183.209.235.37', status: 'success', created_at: now },
  { id: 2, user_id: 2, action: 'session_connect', detail: '连接数据分析PC', ip_addr: '183.209.235.37', status: 'success', created_at: now },
  { id: 3, user_id: 1, action: 'export_approved', detail: '通过导出申请 result_analysis.csv', ip_addr: '183.209.235.37', status: 'success', created_at: now },
  { id: 4, user_id: 1, action: 'platform_test', detail: '测试连接数据分析PC失败: 8.133.223.251:22 — 认证失败', ip_addr: '183.209.235.37', status: 'failed', created_at: now },
]

const mockUsers = [
  { id: 1, username: 'admin', display_name: '管理员', role: 'admin', is_active: true, dept_id: null, dept: null, scopes: [], created_at: now },
  { id: 2, username: 'student1', display_name: '张同学', role: 'user', is_active: true, dept_id: 1, dept: { id: 1, scope_code: 'dept_1', scope_type: 'dept', scope_name: '统计学院', data_path: '/data/dept_1' }, scopes: [], created_at: now },
  { id: 3, username: 'student2', display_name: '李同学', role: 'user', is_active: true, dept_id: 1, dept: { id: 1, scope_code: 'dept_1', scope_type: 'dept', scope_name: '统计学院', data_path: '/data/dept_1' }, scopes: [], created_at: now },
]

const mockScopes = [
  { id: 1, scope_code: 'dept_1', scope_type: 'dept', scope_name: '统计学院', data_path: '/data/dept_1' },
  { id: 2, scope_code: 'proj_1', scope_type: 'project', scope_name: '母婴健康项目', data_path: '/data/proj_1' },
  { id: 3, scope_code: 'proj_2', scope_type: 'project', scope_name: 'ADHD研究项目', data_path: '/data/proj_2' },
]

export default [
  // 认证
  {
    url: '/api/auth/login',
    method: 'post',
    response: () => ({ access_token: 'mock-token-' + Date.now(), token_type: 'bearer' }),
  },
  {
    url: '/api/auth/register',
    method: 'post',
    response: () => ({ id: 99, username: 'newuser', role: 'user', message: '注册成功' }),
  },
  {
    url: '/api/auth/me',
    method: 'get',
    response: () => mockUser,
  },
  {
    url: '/api/auth/change-password',
    method: 'post',
    response: () => ({ message: '密码修改成功，Guacamole 登录密码已同步' }),
  },

  // 会话
  {
    url: '/api/session/connect',
    method: 'post',
    response: () => ({ id: 1, status: 'active', guac_url: '#', launched_at: now }),
  },

  // 数据
  {
    url: '/api/data/fetch',
    method: 'post',
    response: () => ({ filename: 'testData.xlsx', rows: 1074, columns: 612 }),
  },
  {
    url: '/api/data/columns',
    method: 'get',
    response: () => mockColumns,
  },
  {
    url: '/api/data/generate',
    method: 'post',
    response: () => ({ filename: 'testData_20261011_120000.xlsx', rows: 500, columns: 612, target_user: '张同学', windows_path: 'C:\\workspace\\student1\\testData_20261011_120000.xlsx' }),
  },

  // 结果
  {
    url: '/api/results/mine',
    method: 'get',
    response: () => ({ pending: pendingFiles, published: publishedFiles }),
  },
  {
    url: '/api/results/pending-files',
    method: 'get',
    response: () => ({
      files: [
        { file_name: 'result_summary.csv', file_size: 20480, modified_at: '2026-10-24T10:00:00', file_type: 'csv', already_requested: false, existing_status: null },
        { file_name: 'analysis_report.xlsx', file_size: 153600, modified_at: '2026-10-24T09:30:00', file_type: 'xlsx', already_requested: false, existing_status: null },
        { file_name: 'old_result.csv', file_size: 8192, modified_at: '2026-10-23T18:00:00', file_type: 'csv', already_requested: true, existing_status: 'pending' },
      ],
    }),
  },
  {
    url: '/api/results/request-export',
    method: 'post',
    response: () => ({
      registered: 1, files: [], auto_approved: 1, auto_files: [],
      rejected: 0, rejected_files: [], skipped: [], not_found: [],
    }),
  },
  {
    url: '/api/results/:id/download',
    method: 'post',
    response: () => new Blob(['mock csv content'], { type: 'text/csv' }),
  },

  // 管理员
  {
    url: '/api/admin/audit',
    method: 'get',
    response: () => auditLogs,
  },
  {
    url: '/api/admin/pending',
    method: 'get',
    response: () => pendingFiles,
  },
  {
    url: '/api/admin/pending/:id/approve',
    method: 'post',
    response: ({ body }: any) => ({ ...pendingFiles[0], status: 'approved', review_reason: body?.reason }),
  },
  {
    url: '/api/admin/pending/:id/reject',
    method: 'post',
    response: ({ body }: any) => ({ ...pendingFiles[0], status: 'rejected', review_reason: body?.reason }),
  },
  {
    url: '/api/admin/users',
    method: 'get',
    response: () => mockUsers,
  },
  {
    url: '/api/admin/scopes',
    method: 'get',
    response: () => mockScopes,
  },
  {
    url: '/api/admin/users/:id/scopes',
    method: 'put',
    response: () => mockUsers[1],
  },

  // 数据申请
  {
    url: '/api/admin/data-applies',
    method: 'get',
    response: () => mockApplies,
  },
  {
    url: '/api/admin/data-applies/:id/reject',
    method: 'post',
    response: ({ body }: any) => ({ ...mockApplies[0], status: 'rejected', reject_reason: body?.reason }),
  },
  {
    // 申请进入处理中（批量通过）
    url: '/api/admin/data-applies/:id/process',
    method: 'post',
    response: ({ query }: any) => {
      const a = mockApplies.find((x) => x.id === Number(query.id))
      if (a) a.status = 'processing'
      return a || {}
    },
  },
  {
    // 测试连接数据分析PC（模拟：密码非空即成功，否则返回 502 与具体错误）
    url: '/api/admin/platform/test',
    method: 'post',
    response: ({ body }: any) =>
      body?.password
        ? { success: true, message: '连接成功（86ms）', latency_ms: 86 }
        : { code: 502, detail: '认证失败：用户名或密码错误' },
  },
  {
    url: '/api/user/data-applies',
    method: 'get',
    response: () => mockApplies.filter((a) => a.target_user_id === 2),
  },
  {
    url: '/api/user/data-applies',
    method: 'post',
    response: ({ body }: any) => ({ id: 1005, data_name: 'testData', ...body, status: 'pending', apply_time: now }),
  },

  // 消息
  {
    url: '/api/messages',
    method: 'get',
    response: () => mockMessages,
  },
  {
    url: '/api/messages/:id/read',
    method: 'post',
    response: () => ({ id: 1, title: '数据申请已通过', content: '', type: 'success', read: true, created_at: now, link: '/user/my-results' }),
  },
  {
    url: '/api/messages/read-all',
    method: 'post',
    response: () => ({ count: mockMessages.length }),
  },
] as MockMethod[]
