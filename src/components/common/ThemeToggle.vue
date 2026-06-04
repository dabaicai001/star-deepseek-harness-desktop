<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()
</script>

<template>
  <v-btn
    icon
    variant="text"
    @click="themeStore.toggleTheme()"
  >
    <v-icon>
      {{ themeStore.isDark ? 'mdi-weather-sunny' : 'mdi-weather-night' }}
    </v-icon>
  </v-btn>
</template>
