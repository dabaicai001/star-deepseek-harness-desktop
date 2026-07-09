<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import DashboardCard from '@/components/dashboard/DashboardCard.vue'
import type { DashboardDetailTable } from '@/components/dashboard/DashboardCard.vue'
import { loadBrokerOverview, type BrokerKind, type BrokerOverview } from '@/services/broker'
import { useAssetStore } from '@/stores/asset'
import { parseInstanceId } from '@/utils/tabId'
import ProductIcon from '@/components/common/ProductIcon.vue'

const route = useRoute()
const assetStore = useAssetStore()
const assetId = computed(() => parseInstanceId(String(route.params.id || '')).assetId)
const asset = computed(() => assetStore.assets.find(item => item.id === assetId.value))
const kind = computed<BrokerKind>(() => asset.value?.config.dbType === 'nsq' ? 'nsq' : 'kafka')
const loading = ref(true)
const refreshing = ref(false)
const error = ref<string | null>(null)
const sampleKey = ref(0)
const overview = ref<BrokerOverview>({
  kind: 'kafka',
  status: 'offline',
  endpoint: '--',
  nodeCount: 0,
  resources: [],
  observedAt: 0,
})

const totalPartitions = computed(() =>
  overview.value.resources.reduce((total, resource) => total + (resource.partitions || 0), 0))
const totalDepth = computed(() =>
  overview.value.resources.reduce((total, resource) => total + (resource.depth || 0), 0))
const totalMessages = computed(() =>
  overview.value.resources.reduce((total, resource) => total + (resource.messages || 0), 0))
const resourceTable = computed<DashboardDetailTable>(() => ({
  columns: kind.value === 'kafka'
    ? [
        { key: 'name', label: 'Topic', wide: true },
        { key: 'partitions', label: '分区', align: 'right' as const },
        { key: 'leader', label: 'Leader' },
      ]
    : [
        { key: 'name', label: 'Topic', wide: true },
        { key: 'channels', label: 'Channel', align: 'right' as const },
        { key: 'depth', label: '积压', align: 'right' as const },
        { key: 'messages', label: '累计消息', align: 'right' as const },
      ],
  rows: overview.value.resources.map(resource => ({
    name: resource.name,
    partitions: resource.partitions,
    leader: resource.leader,
    channels: resource.channels,
    depth: resource.depth,
    messages: resource.messages,
  })),
  emptyText: `当前 ${kind.value.toUpperCase()} 没有可见 Topic。`,
}))

async function refresh() {
  if (!asset.value?.config.host) return
  refreshing.value = true
  try {
    overview.value = await loadBrokerOverview(kind.value, {
      host: asset.value.config.host,
      port: asset.value.config.port || (kind.value === 'kafka' ? 9092 : 4150),
      username: asset.value.config.username,
      password: asset.value.config.password,
      ssl: asset.value.config.ssl,
    })
    error.value = null
    sampleKey.value += 1
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

let timer: number | null = null
onMounted(() => {
  void refresh()
  timer = window.setInterval(refresh, 30000)
})
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer)
})
watch(assetId, () => {
  loading.value = true
  void refresh()
})
</script>

<template>
  <div class="broker-view grid-bg">
    <div class="broker-header cyber-panel">
      <div>
        <ProductIcon :product="kind" :size="18" />
        <span>{{ asset?.name || kind.toUpperCase() }}</span>
        <code>{{ overview.endpoint }}</code>
      </div>
      <button class="action-btn" title="刷新状态" :disabled="refreshing" @click="refresh">
        <v-icon size="14" :class="{ spin: refreshing }">mdi-refresh</v-icon>
      </button>
    </div>

    <div v-if="error" class="broker-error cyber-panel">
      <v-icon size="14">mdi-alert-circle-outline</v-icon>
      {{ error }}
    </div>

    <div class="broker-dashboard-grid">
      <DashboardCard
        title="连接状态"
        icon="mdi-lan-connect"
        :value="error ? '异常' : overview.status === 'online' ? '在线' : '离线'"
        :color="error ? 'red' : 'green'"
        :loading="loading"
        :chart-value="error ? 0 : 1"
        :sample-key="sampleKey"
        :details="[{ label: 'Endpoint', value: overview.endpoint }]"
      />
      <DashboardCard
        :title="kind === 'kafka' ? 'Broker 节点' : 'NSQD 节点'"
        icon="mdi-server-network"
        :value="overview.nodeCount"
        color="cyan"
        :loading="loading"
        :chart-value="overview.nodeCount"
        :sample-key="sampleKey"
      />
      <DashboardCard
        title="Topic 数量"
        icon="mdi-format-list-bulleted"
        :value="overview.resources.length"
        color="purple"
        :loading="loading"
        :chart-value="overview.resources.length"
        :sample-key="sampleKey"
        :detail-table="resourceTable"
      />
      <DashboardCard
        :title="kind === 'kafka' ? '分区总数' : '当前积压'"
        icon="mdi-chart-timeline-variant"
        :value="kind === 'kafka' ? totalPartitions : totalDepth"
        :color="kind === 'nsq' && totalDepth > 0 ? 'yellow' : 'cyan'"
        :loading="loading"
        :chart-value="kind === 'kafka' ? totalPartitions : totalDepth"
        :sample-key="sampleKey"
        :detail-table="resourceTable"
      />
      <DashboardCard
        v-if="kind === 'nsq'"
        title="累计消息"
        icon="mdi-message-processing"
        :value="totalMessages.toLocaleString()"
        color="green"
        :loading="loading"
        :chart-value="totalMessages"
        :sample-key="sampleKey"
        :detail-table="resourceTable"
      />
    </div>
  </div>
</template>
