<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useTheme } from 'vuetify'
import { useThemeStore } from '@/stores/theme'
import { useI18n } from 'vue-i18n'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import GlobalDialogHost from '@/components/common/GlobalDialogHost.vue'
import GlobalToast from '@/components/common/GlobalToast.vue'
import { isEmbedMode } from '@/lib/embed'

const themeStore = useThemeStore()
const { t } = useI18n()
const vuetifyTheme = useTheme()
const router = useRouter()
const appReady = ref(false)

onMounted(async () => {
  try {
    await router.isReady()
  } finally {
    // embed 模式(dsh 壳 iframe):跳过启动页门控直接渲染,iframe 出现即工作区
    if (isEmbedMode()) {
      appReady.value = true
      return
    }
    // rAF 在隐藏/后台标签页里可能永不触发(浏览器节流),
    // 那样 appReady 永远为 false,应用会一直停在启动页。
    // 隐藏时退化为 setTimeout,可见时仍用 rAF 保证首帧后再亮界面。
    if (document.visibilityState === 'hidden') {
      setTimeout(() => {
        appReady.value = true
      }, 0)
    } else {
      requestAnimationFrame(() => {
        appReady.value = true
      })
    }
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
