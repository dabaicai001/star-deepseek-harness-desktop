import { defineStore } from 'pinia'
import { ref } from 'vue'

export type DialogKind = 'prompt' | 'confirm' | 'alert'

export interface PromptOptions {
  title?: string
  message: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
  requireNonEmpty?: boolean
  // prompt 专用: 下拉选择(传了 selectOptions 就不再渲染普通 input,改用下拉)
  selectOptions?: string[]
  selectDefault?: string
}

export interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  requireTyping?: string
}

export interface AlertOptions {
  title?: string
  message: string
  confirmText?: string
  color?: 'info' | 'success' | 'warning' | 'error'
}

// 一次只展示一个 dialog —— 后续调用覆盖前一次(用 ignore 标记,直接 resolve 掉旧的)
type Resolver<T> = (value: T) => void

export const useDialogStore = defineStore('dialog', () => {
  const visible = ref(false)
  const kind = ref<DialogKind>('confirm')

  // prompt
  const promptTitle = ref('')
  const promptMessage = ref('')
  const promptDefault = ref('')
  const promptPlaceholder = ref('')
  const promptConfirmText = ref('')
  const promptCancelText = ref('')
  const promptRequireNonEmpty = ref(false)
  const promptSelectOptions = ref<string[] | null>(null)
  const promptSelectDefault = ref<string | null>(null)

  // confirm
  const confirmTitle = ref('')
  const confirmMessage = ref('')
  const confirmConfirmText = ref('')
  const confirmCancelText = ref('')
  const confirmDanger = ref(false)
  const confirmRequireTyping = ref<string | null>(null)

  // alert
  const alertTitle = ref('')
  const alertMessage = ref('')
  const alertConfirmText = ref('')
  const alertColor = ref<'info' | 'success' | 'warning' | 'error'>('info')

  let resolver: Resolver<any> | null = null

  function reset() {
    promptTitle.value = ''
    promptMessage.value = ''
    promptDefault.value = ''
    promptPlaceholder.value = ''
    promptConfirmText.value = ''
    promptCancelText.value = ''
    promptRequireNonEmpty.value = false
    promptSelectOptions.value = null
    promptSelectDefault.value = null
    confirmTitle.value = ''
    confirmMessage.value = ''
    confirmConfirmText.value = ''
    confirmCancelText.value = ''
    confirmDanger.value = false
    confirmRequireTyping.value = null
    alertTitle.value = ''
    alertMessage.value = ''
    alertConfirmText.value = ''
    alertColor.value = 'info'
  }

  function alert(options: AlertOptions | string): Promise<void> {
    if (resolver) resolver(false)
    reset()
    if (typeof options === 'string') {
      alertMessage.value = options
    } else {
      alertTitle.value = options.title ?? ''
      alertMessage.value = options.message
      alertConfirmText.value = options.confirmText ?? ''
      alertColor.value = options.color ?? 'info'
    }
    kind.value = 'alert'
    visible.value = true
    return new Promise<void>((resolve) => {
      resolver = resolve as Resolver<unknown>
    })
  }

  function confirm(options: ConfirmOptions | string): Promise<boolean> {
    if (resolver) resolver(false)
    reset()
    if (typeof options === 'string') {
      confirmMessage.value = options
    } else {
      confirmTitle.value = options.title ?? ''
      confirmMessage.value = options.message
      confirmConfirmText.value = options.confirmText ?? ''
      confirmCancelText.value = options.cancelText ?? ''
      confirmDanger.value = options.danger ?? false
      confirmRequireTyping.value = options.requireTyping ?? null
    }
    kind.value = 'confirm'
    visible.value = true
    return new Promise<boolean>((resolve) => {
      resolver = resolve
    })
  }

  function prompt(options: PromptOptions | string, defaultValue = ''): Promise<string | null> {
    if (resolver) resolver(null)
    reset()
    if (typeof options === 'string') {
      promptMessage.value = options
      promptDefault.value = defaultValue
    } else {
      promptTitle.value = options.title ?? ''
      promptMessage.value = options.message
      promptDefault.value = options.defaultValue ?? defaultValue
      promptPlaceholder.value = options.placeholder ?? ''
      promptConfirmText.value = options.confirmText ?? ''
      promptCancelText.value = options.cancelText ?? ''
      promptRequireNonEmpty.value = options.requireNonEmpty ?? false
      promptSelectOptions.value = options.selectOptions ?? null
      promptSelectDefault.value = options.selectDefault ?? null
    }
    kind.value = 'prompt'
    visible.value = true
    return new Promise<string | null>((resolve) => {
      resolver = resolve
    })
  }

  function resolveWith(value: any) {
    const r = resolver
    resolver = null
    visible.value = false
    if (r) r(value)
  }

  return {
    visible,
    kind,
    promptTitle, promptMessage, promptDefault, promptPlaceholder,
    promptConfirmText, promptCancelText, promptRequireNonEmpty,
    promptSelectOptions, promptSelectDefault,
    confirmTitle, confirmMessage, confirmConfirmText, confirmCancelText,
    confirmDanger, confirmRequireTyping,
    alertTitle, alertMessage, alertConfirmText, alertColor,
    alert, confirm, prompt, resolveWith,
  }
})
