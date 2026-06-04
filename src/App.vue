<script setup lang="ts">
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()
</script>

<template>
  <v-app :theme="themeStore.theme">
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>
