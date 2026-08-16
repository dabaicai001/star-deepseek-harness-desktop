<script setup lang="ts">
/**
 * embed 段路由(如 /ssh,无资产 id)的空态页(方案第 3 章 3.2)。
 *
 * embed 守卫在「该类型无资产」时停在段路由,本组件渲染空态;
 * 直接内联「新建连接」表单(NewConnectionDialog),不再只给「去设置」按钮;
 * 新建成功直接跳进新资产的实例操作页(方案 3.3 一步到位);
 * 有资产时守卫直接重定向到带 instanceId 的功能路由,不会落到这里。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import { embedSectionForRoute } from '@/lib/embed'
import { routeNameForAsset } from '@/utils/assetRouting'
import { generateInstanceId } from '@/utils/tabId'
import type { CreateAssetDto } from '@/types/asset'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const assetStore = useAssetStore()
const section = computed(() => embedSectionForRoute(route))

/** 段 key → 资产类型(NewConnectionDialog 的 initialType) */
function sectionToAssetType(key: string): 'ssh' | 'db' | 'docker' | undefined {
  if (key === 'terminal') return 'ssh'
  if (key === 'database' || key === 'redis' || key === 'elasticsearch'
    || key === 'clickhouse' || key === 'postgresql') return 'db'
  if (key === 'docker') return 'docker'
  return undefined
}

const showNewDialog = ref(false)

async function onCreateAsset(dto: CreateAssetDto) {
  try {
    const created = await assetStore.createAsset(dto)
    showNewDialog.value = false
    // 方案 3.3:新建成功直接落进新资产的实例操作页(路由名按资产类型派生)
    router.replace({ name: routeNameForAsset(created), params: { id: generateInstanceId(created.id) } }).catch(() => {})
  } catch (err) {
    // 保持对话框打开让用户修正;错误由对话框侧提示
    void err
  }
}
</script>

<template>
  <div class="cyber-embed-empty">
    <v-icon size="28" class="cyber-embed-empty-icon">{{ section?.icon ?? 'mdi-shape-outline' }}</v-icon>
    <div class="cyber-embed-empty-title">{{ t('embed.empty.title') }}</div>
    <div class="cyber-embed-empty-hint">{{ t('embed.empty.hint') }}</div>
    <!-- 方案 3.2:内联新建连接,不再跳设置 -->
    <button class="cyber-embed-bar-action" @click="showNewDialog = true">
      <v-icon size="12">mdi-plus</v-icon>
      <span>{{ t('embed.assetBar.newConnection') }}</span>
    </button>
    <NewConnectionDialog
      v-model="showNewDialog"
      :initial-type="section ? sectionToAssetType(section.key) : undefined"
      @submit="onCreateAsset"
    />
  </div>
</template>
