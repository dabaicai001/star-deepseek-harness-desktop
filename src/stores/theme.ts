import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<'lightTheme' | 'darkTheme'>('lightTheme')
  const isDark = ref(false)

  function toggleTheme() {
    theme.value = theme.value === 'lightTheme' ? 'darkTheme' : 'lightTheme'
    isDark.value = theme.value === 'darkTheme'
  }

  function setTheme(newTheme: 'lightTheme' | 'darkTheme') {
    theme.value = newTheme
    isDark.value = newTheme === 'darkTheme'
  }

  function followSystem() {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    setTheme(mediaQuery.matches ? 'darkTheme' : 'lightTheme')
    mediaQuery.addEventListener('change', (e) => {
      setTheme(e.matches ? 'darkTheme' : 'lightTheme')
    })
  }

  return {
    theme,
    isDark,
    toggleTheme,
    setTheme,
    followSystem
  }
}, {
  persist: true
})
