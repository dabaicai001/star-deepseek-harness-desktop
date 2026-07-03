import { defineStore } from 'pinia'
import { ref } from 'vue'

export type NotifyColor = 'success' | 'info' | 'warning' | 'error'

export interface NotifyOptions {
  message: string
  color?: NotifyColor
  timeout?: number
  title?: string
  details?: string | string[]
}

export interface NotifyHistoryItem {
  id: string
  title: string
  message: string
  color: NotifyColor
  createdAt: number
  read: boolean
  details: string[]
}

export const useNotifyStore = defineStore('notify', () => {
  const show = ref(false)
  const message = ref('')
  const color = ref<NotifyColor>('info')
  const timeout = ref(3000)
  const history = ref<NotifyHistoryItem[]>([])

  const unreadCount = ref(0)

  function notify(opts: NotifyOptions | string) {
    const next = typeof opts === 'string'
      ? { message: opts, color: 'info' as NotifyColor, timeout: 3000, title: '通知', details: [] as string[] }
      : {
          message: opts.message,
          color: opts.color ?? 'info',
          timeout: opts.timeout ?? 3000,
          title: opts.title ?? (opts.color === 'error' ? '失败' : opts.color === 'success' ? '完成' : opts.color === 'warning' ? '提醒' : '通知'),
          details: normalizeDetails(opts.details)
        }
    const createdAt = Date.now()

    message.value = next.message
    color.value = next.color
    timeout.value = next.timeout
    history.value.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: next.title,
      message: next.message,
      color: next.color,
      createdAt,
      read: false,
      details: buildDetails({
        title: next.title,
        message: next.message,
        color: next.color,
        createdAt,
        details: next.details
      })
    })
    history.value = history.value.slice(0, 80)
    unreadCount.value = history.value.filter(item => !item.read).length
    show.value = true
  }

  function markAllRead() {
    for (const item of history.value) item.read = true
    unreadCount.value = 0
  }

  function clearHistory() {
    history.value = []
    unreadCount.value = 0
  }

  return { show, message, color, timeout, history, unreadCount, notify, markAllRead, clearHistory }
}, {
  persist: {
    paths: ['history', 'unreadCount']
  }
})

function normalizeDetails(details: NotifyOptions['details']): string[] {
  if (!details) return []
  return Array.isArray(details) ? details.filter(Boolean) : [details]
}

function statusText(color: NotifyColor): string {
  if (color === 'success') return '成功'
  if (color === 'error') return '失败'
  if (color === 'warning') return '警告'
  return '信息'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function buildDetails(item: {
  title: string
  message: string
  color: NotifyColor
  createdAt: number
  details: string[]
}): string[] {
  return [
    `操作: ${item.title}`,
    `状态: ${statusText(item.color)}`,
    `时间: ${formatTime(item.createdAt)}`,
    `内容: ${item.message}`,
    ...item.details
  ]
}
