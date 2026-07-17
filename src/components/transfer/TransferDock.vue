<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTransferStore } from '@/stores/transfer'
import { formatSize } from '@/services/sftp'

const { t } = useI18n()
const transferStore = useTransferStore()

const speedOptions = [
  { label: 'sftp.speedUnlimited', value: 0 },
  { label: '1 MB/s', value: 1048576 },
  { label: '2 MB/s', value: 2097152 },
  { label: '5 MB/s', value: 5242880 },
  { label: '10 MB/s', value: 10485760 },
]

/** 任务条标题:传输中 N · 68% / 空闲时只显示标题 */
const pillText = computed(() => {
  if (transferStore.activeCount === 0) {
    return t('sftp.transfers')
  }
  const pct = transferStore.aggregatePercent
  return pct >= 0
    ? `${t('sftp.transferActive', { count: transferStore.activeCount })} · ${pct}%`
    : t('sftp.transferActive', { count: transferStore.activeCount })
})

function fileLabel(item: { files: { name: string }[] }): string {
  return item.files.length === 1 ? item.files[0].name : `${item.files.length} files`
}
</script>

<template>
  <div v-if="transferStore.tasks.size > 0" class="transfer-dock">
    <!-- 展开态:任务列表面板 -->
    <Transition name="transfer-dock-pop">
      <div v-if="transferStore.expanded" class="transfer-dock-panel cyber-panel">
        <div class="transfer-dock-header">
          <span class="transfer-dock-title">{{ t('sftp.transfers') }}</span>
          <span v-if="transferStore.activeCount > 0" class="cyber-badge">
            {{ transferStore.activeCount }}
          </span>
          <div class="transfer-dock-header-actions">
            <button
              v-if="transferStore.finishedCount > 0"
              class="action-btn"
              :data-tooltip="t('sftp.clearFinished')"
              :aria-label="t('sftp.clearFinished')"
              @click="transferStore.clearFinished()"
            >
              <v-icon size="14">mdi-delete-sweep-outline</v-icon>
            </button>
            <button
              class="action-btn"
              :data-tooltip="t('sftp.minimize')"
              :aria-label="t('sftp.minimize')"
              @click="transferStore.expanded = false"
            >
              <v-icon size="14">mdi-chevron-down</v-icon>
            </button>
          </div>
        </div>

        <div class="transfer-dock-list">
          <div v-if="transferStore.taskList.length === 0" class="transfer-empty">
            {{ t('sftp.noTransfers') }}
          </div>
          <div
            v-for="item in transferStore.taskList"
            :key="item.transferId"
            class="transfer-item"
            :class="item.status"
          >
            <div class="transfer-item-row">
              <v-icon size="12" :color="item.direction === 'upload' ? 'cyan' : 'green'">
                {{ item.direction === 'upload' ? 'mdi-upload' : 'mdi-download' }}
              </v-icon>
              <span class="transfer-file-name" :title="fileLabel(item)">
                {{ fileLabel(item) }}
              </span>
              <span v-if="item.status === 'running'" class="transfer-speed">
                {{ transferStore.speedOf(item) }}
              </span>
              <span class="transfer-percent">{{ transferStore.progressPercent(item) }}%</span>
              <button
                v-if="item.status === 'running' || item.status === 'queued'"
                class="action-btn transfer-item-btn"
                :data-tooltip="t('sftp.cancelTransfer')"
                :aria-label="t('sftp.cancelTransfer')"
                @click="transferStore.cancel(item)"
              >
                <v-icon size="12">mdi-close</v-icon>
              </button>
              <button
                v-if="item.status === 'failed' || item.status === 'cancelled'"
                class="action-btn transfer-item-btn retry"
                :data-tooltip="t('sftp.retryTransfer')"
                :aria-label="t('sftp.retryTransfer')"
                @click="transferStore.retry(item)"
              >
                <v-icon size="12">mdi-refresh</v-icon>
              </button>
              <v-icon v-if="item.status === 'done'" size="12" color="green">mdi-check</v-icon>
            </div>
            <div class="transfer-progress-bar">
              <div
                class="transfer-progress-fill"
                :class="item.status"
                :style="{ width: transferStore.progressPercent(item) + '%' }"
              />
            </div>
            <div v-if="item.error" class="transfer-error">{{ item.error }}</div>
          </div>
        </div>

        <div class="transfer-dock-footer">
          <span class="transfer-footer-label">{{ t('sftp.speedLimit') }}:</span>
          <select
            :value="transferStore.speedLimit"
            class="transfer-speed-select"
            @change="transferStore.applySpeedLimit(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="opt in speedOptions" :key="opt.value" :value="opt.value">
              {{ opt.value === 0 ? t('sftp.speedUnlimited') : opt.label }}
            </option>
          </select>
          <span class="transfer-footer-stats">
            {{ transferStore.totalStats.count }} · {{ formatSize(transferStore.totalStats.bytes) }}
          </span>
        </div>
      </div>
    </Transition>

    <!-- 任务条(最小化态常驻,展开时作为底条) -->
    <button
      class="transfer-dock-pill"
      :class="{ active: transferStore.activeCount > 0, expanded: transferStore.expanded }"
      :aria-label="t('sftp.transfers')"
      @click="transferStore.toggleExpanded()"
    >
      <v-icon size="14">
        {{ transferStore.activeCount > 0 ? 'mdi-loading mdi-spin' : 'mdi-swap-vertical-bold' }}
      </v-icon>
      <span class="transfer-pill-text">{{ pillText }}</span>
      <span
        v-if="transferStore.activeCount > 0 && transferStore.aggregatePercent >= 0"
        class="transfer-pill-bar"
      >
        <span :style="{ width: transferStore.aggregatePercent + '%' }" />
      </span>
      <v-icon size="12" class="transfer-pill-caret">
        {{ transferStore.expanded ? 'mdi-chevron-down' : 'mdi-chevron-up' }}
      </v-icon>
    </button>
  </div>
</template>
