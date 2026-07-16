<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTheme } from 'vuetify'
import { useThemeStore } from '@/stores/theme'
import { useI18n } from 'vue-i18n'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import GlobalDialogHost from '@/components/common/GlobalDialogHost.vue'
import GlobalToast from '@/components/common/GlobalToast.vue'

const themeStore = useThemeStore()
const { t } = useI18n()
const vuetifyTheme = useTheme()
const router = useRouter()
const appReady = ref(false)

onMounted(async () => {
  try {
    await router.isReady()
  } finally {
    requestAnimationFrame(() => {
      appReady.value = true
    })
  }
})

// 持久化的主题名同步到 vuetify
watch(
  () => themeStore.theme,
  (name) => {
    vuetifyTheme.change(name)
  },
  { immediate: true }
)
</script>

<template>
  <v-app class="grid-bg">
    <div v-if="!appReady" class="app-startup" role="status" :aria-label="t('common.loading')">
      <div class="app-startup-mark" aria-hidden="true">S</div>
      <div class="app-startup-name">STARHUB</div>
      <div class="app-startup-status">{{ t('common.loading') }}<span class="app-startup-dots" aria-hidden="true" /></div>
    </div>
    <template v-else>
      <ErrorBoundary>
        <router-view />
      </ErrorBoundary>
      <GlobalDialogHost />
      <GlobalToast />
    </template>
  </v-app>
</template>
