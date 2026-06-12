<script setup lang="ts">
import { watch } from 'vue'
import { useTheme } from 'vuetify'
import { useThemeStore } from '@/stores/theme'
import { useI18n } from 'vue-i18n'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import GlobalDialogHost from '@/components/common/GlobalDialogHost.vue'
import GlobalToast from '@/components/common/GlobalToast.vue'

const themeStore = useThemeStore()
const { t } = useI18n()
const vuetifyTheme = useTheme()

// 持久化的主题名同步到 vuetify
watch(
  () => themeStore.theme,
  (name) => {
    vuetifyTheme.global.name.value = name
  },
  { immediate: true }
)
</script>

<template>
  <v-app class="grid-bg">
    <ErrorBoundary>
      <router-view />
    </ErrorBoundary>
    <GlobalDialogHost />
    <GlobalToast />
  </v-app>
</template>

<style>
/* @import must precede all other CSS rules */
@import './styles/cyber.css';

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  height: 100%;
  overflow: hidden;
}

body {
  font-family: 'Outfit', -apple-system, 'PingFang SC', sans-serif;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}

.v-application {
  font-family: 'Outfit', -apple-system, 'PingFang SC', sans-serif !important;
}
</style>
