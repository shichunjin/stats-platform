import axios, { AxiosError, type AxiosResponse } from 'axios'
import { ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'
import router from '@/router'

// 根据是否启用 Mock 决定 baseURL
// 开发时用相对路径走 Vite 代理；mock 开启时走 /mock 前缀
const baseURL = import.meta.env.DEV ? '/api' : ''

const request = axios.create({
  baseURL,
  timeout: 60000,
})

// 请求拦截：带 token
request.interceptors.request.use((config) => {
  const userStore = useUserStore()
  if (userStore.token) {
    config.headers.Authorization = `Bearer ${userStore.token}`
  }
  return config
})

// 响应拦截：统一错误处理
request.interceptors.response.use(
  (response: AxiosResponse) => response.data,
  (error: AxiosError<any>) => {
    const status = error.response?.status
    const detail = error.response?.data?.detail || error.message

    if (status === 401) {
      ElMessage.error('登录已过期，请重新登录')
      const userStore = useUserStore()
      userStore.logout()
      router.push('/login')
    } else if (status === 403) {
      ElMessage.error('没有权限执行该操作')
    } else if (status === 404) {
      ElMessage.error(detail || '资源不存在')
    } else if (status && status >= 500) {
      ElMessage.error('服务器错误，请稍后重试')
    } else {
      ElMessage.error(detail || '请求失败')
    }
    return Promise.reject(error)
  },
)

export default request
