import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

export type ThemeMode = 'lightTheme' | 'darkTheme'
/** 主色主题(用于 --cyan / --grad-primary 等) */
export type AccentColor = 'cyan' | 'purple' | 'green' | 'orange'

/** 主色 → [cyanHex, purpleHex] 映射(用于 CSS 变量 --cyan / --purple) */
const ACCENT_MAP: Record<ThemeMode, Record<AccentColor, { primary: string; secondary: string }>> = {
  darkTheme: {
    cyan:   { primary: '#5dd6d6', secondary: '#8f7bd8' },
    purple: { primary: '#8f7bd8', secondary: '#5dd6d6' },
    green:  { primary: '#6fd28a', secondary: '#5dd6d6' },
    orange: { primary: '#d89b65', secondary: '#e2bf5a' }
  },
  lightTheme: {
    cyan:   { primary: '#536a78', secondary: '#6d6598' },
    purple: { primary: '#6d6598', secondary: '#536a78' },
    green:  { primary: '#4f785a', secondary: '#536a78' },
    orange: { primary: '#8d7440', secondary: '#9b7a28' }
  }
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>('lightTheme')
  const accent = ref<AccentColor>('cyan')
  const fontSize = ref(14)
  const isDark = computed(() => theme.value === 'darkTheme')

  let cleanupSystemListener: (() => void) | null = null

  function toggleTheme() {
    theme.value = theme.value === 'lightTheme' ? 'darkTheme' : 'lightTheme'
  }

  function setTheme(newTheme: ThemeMode) {
    theme.value = newTheme
  }

  // 把主题 class 同步到 <html> 上,这样 teleport 到 body 的元素
  // (v-dialog overlay / .context-menu / tooltip / xterm / Monaco) 也能匹配
  // token 作用域,不依赖 .v-application 容器
  function syncHtmlClass(current: ThemeMode) {
    if (typeof document === 'undefined') return
    const html = document.documentElement
    html.classList.remove('v-theme--darkTheme', 'v-theme--lightTheme')
    html.classList.add(`v-theme--${current}`)
  }

  function setAccent(color: AccentColor) {
    accent.value = color
  }

  function setFontSize(size: number) {
    fontSize.value = Math.min(24, Math.max(10, size))
  }

  function syncAccent(currentTheme: ThemeMode, currentAccent: AccentColor) {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const { primary, secondary } = ACCENT_MAP[currentTheme][currentAccent]
    root.style.setProperty('--cyan', primary)
    root.style.setProperty('--purple', secondary)
  }

  function followSystem() {
    cleanupSystemListener?.()

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      setTheme(e.matches ? 'darkTheme' : 'lightTheme')
    }

    setTheme(mediaQuery.matches ? 'darkTheme' : 'lightTheme')
    mediaQuery.addEventListener('change', handler)

    cleanupSystemListener = () => {
      mediaQuery.removeEventListener('change', handler)
    }
  }

  function cleanup() {
    cleanupSystemListener?.()
    cleanupSystemListener = null
  }

  // 把 accent 写入 :root CSS 变量,让所有使用 var(--cyan) 的地方跟着切。
  // 浅色主题单独用低饱和钢蓝灰,避免白底下被旧的电青色覆盖。
  watch(accent, (next) => {
    syncAccent(theme.value, next)
  }, { immediate: true })

  // 主题切换时同步 class 到 <html>,让 teleport 出来的元素也能拿到 token
  watch(theme, (next) => {
    syncHtmlClass(next)
    syncAccent(next, accent.value)
  }, { immediate: true })

  return {
    theme,
    accent,
    fontSize,
    isDark,
    toggleTheme,
    setTheme,
    setAccent,
    setFontSize,
    followSystem,
    cleanup
  }
}, {
  persist: {
    key: 'theme-v2'
  }
})
