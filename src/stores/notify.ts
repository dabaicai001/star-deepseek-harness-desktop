import { defineStore } from 'pinia'
import { ref } from 'vue'

export type NotifyColor = 'success' | 'info' | 'warning' | 'error'

export interface NotifyOptions {
  message: string
  color?: NotifyColor
  timeout?: number
  title?: string
}

export const useNotifyStore = defineStore('notify', () => {
  const show = ref(false)
  const message = ref('')
  const color = ref<NotifyColor>('info')
  const timeout = ref(3000)
  const history = ref<Array<{
    id: string
    title: string
    message: string
    color: NotifyColor
    createdAt: number
    read: boolean
  }>>([])

  const unreadCount = ref(0)

  function notify(opts: NotifyOptions | string) {
    const next = typeof opts === 'string'
      ? { message: opts, color: 'info' as NotifyColor, timeout: 3000, title: '通知' }
      : {
          message: opts.message,
          color: opts.color ?? 'info',
          timeout: opts.timeout ?? 3000,
          title: opts.title ?? (opts.color === 'error' ? '失败' : opts.color === 'success' ? '完成' : opts.color === 'warning' ? '提醒' : '通知')
        }

    message.value = next.message
    color.value = next.color
    timeout.value = next.timeout
    history.value.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: next.title,
      message: next.message,
      color: next.color,
      createdAt: Date.now(),
      read: false
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
