<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'
import ThemeToggle from '@/components/common/ThemeToggle.vue'

const themeStore = useThemeStore()
</script>

<template>
  <v-app :theme="themeStore.theme">
    <v-app-bar>
      <v-app-bar-title>{{ $t('common.app') }}</v-app-bar-title>
      <v-spacer />
      <ThemeToggle />
    </v-app-bar>
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>
