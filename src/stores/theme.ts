import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

export type ThemeMode = 'lightTheme' | 'darkTheme'
/** 主色主题(用于 --cyan / --grad-primary 等) */
export type AccentColor = 'cyan' | 'purple' | 'green' | 'orange'

/** 主色 → [cyanHex, purpleHex] 映射(用于 CSS 变量 --cyan / --purple) */
const ACCENT_MAP: Record<AccentColor, { primary: string; secondary: string }> = {
  cyan:   { primary: '#00f0ff', secondary: '#b56bff' },
  purple: { primary: '#b56bff', secondary: '#00f0ff' },
  green:  { primary: '#4ade80', secondary: '#00f0ff' },
  orange: { primary: '#ff7a3a', secondary: '#ffd84d' }
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<ThemeMode>('darkTheme')
  const accent = ref<AccentColor>('cyan')
  const isDark = computed(() => theme.value === 'darkTheme')

  let cleanupSystemListener: (() => void) | null = null

  function toggleTheme() {
    theme.value = theme.value === 'lightTheme' ? 'darkTheme' : 'lightTheme'
  }

  function setTheme(newTheme: ThemeMode) {
    theme.value = newTheme
  }

  function setAccent(color: AccentColor) {
    accent.value = color
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

  // 把 accent 写入 :root CSS 变量,让所有使用 var(--cyan) 的地方跟着切
  watch(accent, (next) => {
    const root = document.documentElement
    const { primary, secondary } = ACCENT_MAP[next]
    root.style.setProperty('--cyan', primary)
    root.style.setProperty('--purple', secondary)
  }, { immediate: true })

  return {
    theme,
    accent,
    isDark,
    toggleTheme,
    setTheme,
    setAccent,
    followSystem,
    cleanup
  }
}, {
  persist: {
    key: 'theme-v2'
  }
})
