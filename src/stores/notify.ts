import { defineStore } from 'pinia'
import { ref } from 'vue'

export type NotifyColor = 'success' | 'info' | 'warning' | 'error'

export interface NotifyOptions {
  message: string
  color?: NotifyColor
  timeout?: number
}

export const useNotifyStore = defineStore('notify', () => {
  const show = ref(false)
  const message = ref('')
  const color = ref<NotifyColor>('info')
  const timeout = ref(3000)

  function notify(opts: NotifyOptions | string) {
    if (typeof opts === 'string') {
      message.value = opts
      color.value = 'info'
      timeout.value = 3000
    } else {
      message.value = opts.message
      color.value = opts.color ?? 'info'
      timeout.value = opts.timeout ?? 3000
    }
    show.value = true
  }

  return { show, message, color, timeout, notify }
})
