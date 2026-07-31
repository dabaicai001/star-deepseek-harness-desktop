<script setup lang="ts">
/**
 * Elasticsearch 集群总览(右侧面板 dashboard tab)
 *
 * - 集群健康卡片 + 索引统计卡片
 * - 全量索引列表(点击行切换到索引详情)
 * - 数据由父视图加载后以 props 传入,本组件不直接发起请求
 */
import { useI18n } from 'vue-i18n'
import type { EsIndexInfo } from '@/types/db'

interface EsClusterHealth {
  status: string
  numberOfNodes: number
  activeShardsPercent: number
}

defineProps<{
  clusterHealth: EsClusterHealth | null
  indices: EsIndexInfo[]
}>()

const emit = defineEmits<{
  selectIndex: [name: string]
}>()

const { t } = useI18n()

function getHealthColor(status: string): string {
  if (status === 'green') return 'var(--green)'
  if (status === 'yellow') return 'var(--yellow)'
  return 'var(--red)'
}
</script>

<template>
  <div class="es-overview">
    <div class="overview-grid">
      <div class="cyber-card cluster-health-card">
        <div class="card-title"><span class="status-dot" :style="{ backgroundColor: getHealthColor(clusterHealth?.status || 'red') }" />{{ t('db.clusterHealth') }}</div>
        <div class="health-stats" v-if="clusterHealth">
          <div class="health-stat"><span class="stat-value" :style="{ color: getHealthColor(clusterHealth.status) }">{{ clusterHealth.status }}</span><span class="stat-label">Status</span></div>
          <div class="health-stat"><span class="stat-value">{{ clusterHealth.numberOfNodes }}</span><span class="stat-label">Nodes</span></div>
          <div class="health-stat"><span class="stat-value">{{ clusterHealth.activeShardsPercent.toFixed(1) }}%</span><span class="stat-label">Active Shards</span></div>
        </div>
      </div>
      <div class="cyber-card"><div class="card-title">{{ t('db.indices') }}</div><div class="index-stats-summary"><div class="health-stat"><span class="stat-value">{{ indices.length }}</span><span class="stat-label">Total Indices</span></div><div class="health-stat"><span class="stat-value">{{ indices.reduce((s, i) => s + (i.docsCount || 0), 0).toLocaleString() }}</span><span class="stat-label">Total Docs</span></div></div></div>
    </div>
    <div class="indices-table-wrap">
      <table class="data-table"><thead><tr><th>{{ t('asset.name') }}</th><th>{{ t('db.rows') }}</th><th>Shards</th><th>{{ t('sftp.size') }}</th><th>Health</th><th>Status</th></tr></thead><tbody><tr v-for="idx in indices" :key="idx.name" @click="emit('selectIndex', idx.name)" class="clickable-row"><td class="mono">{{ idx.name }}</td><td class="mono">{{ idx.docsCount?.toLocaleString() }}</td><td class="mono">{{ idx.primaryShards }}P / {{ idx.replicaShards }}R</td><td class="mono">{{ idx.storeSize }}</td><td><span class="status-dot" :style="{ backgroundColor: getHealthColor(idx.health) }" /> {{ idx.health }}</td><td>{{ idx.status }}</td></tr></tbody></table>
    </div>
  </div>
</template>

<style scoped>
.es-overview { flex: 1; overflow-y: auto; padding: 16px; }
.overview-grid { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 16px; }
.health-stats, .index-stats-summary { display: flex; gap: 24px; margin-top: 12px; }
.health-stat { display: flex; flex-direction: column; gap: 4px; }
.stat-value { font-size: 20px; font-weight: 700; font-family: 'JetBrains Mono', monospace; }
.stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.indices-table-wrap { overflow-x: auto; margin-top: 8px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.data-table th { text-align: left; padding: 6px 10px; color: var(--muted); font-weight: 600; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid var(--line); }
.data-table td { padding: 5px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
.clickable-row { cursor: pointer; }
.clickable-row:hover { background: rgba(0, 240, 255, 0.04); }
.card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mono { font-family: 'JetBrains Mono', monospace; }
</style>
