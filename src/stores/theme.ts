import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<'lightTheme' | 'darkTheme'>('lightTheme')
  const isDark = computed(() => theme.value === 'darkTheme')

  let cleanupSystemListener: (() => void) | null = null

  function toggleTheme() {
    theme.value = theme.value === 'lightTheme' ? 'darkTheme' : 'lightTheme'
  }

  function setTheme(newTheme: 'lightTheme' | 'darkTheme') {
    theme.value = newTheme
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

  return {
    theme,
    isDark,
    toggleTheme,
    setTheme,
    followSystem,
    cleanup
  }
}, {
  persist: true
})
