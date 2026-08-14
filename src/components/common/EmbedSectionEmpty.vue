<script setup lang="ts">
/**
 * embed 段路由(如 /ssh,无资产 id)的空态页(P3 主壳融合)。
 *
 * embed 守卫在「该类型无资产」时停在段路由,本组件渲染空态;
 * 有资产时守卫直接重定向到带 instanceId 的功能路由,不会落到这里。
 * 「去设置添加」经 postMessage 让 dsh 壳(client-nav overlay)切到设置页。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { embedSectionForRoute, postEmbedOpenSection } from '@/lib/embed'

const { t } = useI18n()
const route = useRoute()
const section = computed(() => embedSectionForRoute(route))
</script>

<template>
  <div class="cyber-embed-empty">
    <v-icon size="28" class="cyber-embed-empty-icon">{{ section?.icon ?? 'mdi-shape-outline' }}</v-icon>
    <div class="cyber-embed-empty-title">{{ t('embed.empty.title') }}</div>
    <div class="cyber-embed-empty-hint">{{ t('embed.empty.hint') }}</div>
    <button class="cyber-embed-bar-action" @click="postEmbedOpenSection('settings')">
      <v-icon size="12">mdi-plus</v-icon>
      <span>{{ t('embed.empty.goSettings') }}</span>
    </button>
  </div>
</template>
