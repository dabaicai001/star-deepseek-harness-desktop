<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SshConnectionForm from '@/components/ssh/SshConnectionForm.vue'
import type { CreateAssetDto, Asset } from '@/types/asset'

const { t } = useI18n()

const props = defineProps<{
  modelValue: boolean
  asset?: Asset | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  submit: [dto: CreateAssetDto]
  update: [payload: { id: string; dto: CreateAssetDto }]
}>()

const step = ref<'type' | 'ssh'>('type')

const mode = computed<'create' | 'edit'>(() => (props.asset ? 'edit' : 'create'))

function selectType(type: string) {
  if (type === 'ssh') {
    step.value = 'ssh'
  }
  // db / docker 后续补充
}

function handleSshSubmit(dto: CreateAssetDto) {
  if (mode.value === 'edit' && props.asset) {
    emit('update', { id: props.asset.id, dto })
  } else {
    emit('submit', dto)
  }
  close()
}

function close() {
  step.value = 'type'
  emit('update:modelValue', false)
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    max-width="640"
    persistent
    transition="dialog-bottom-transition"
    scrollable
  >
    <div class="new-conn-dialog">
      <!-- Type Selection -->
      <template v-if="step === 'type'">
        <div class="modal-header">
          <div class="icon-box">
            <v-icon size="14">{{ mode === 'edit' ? 'mdi-pencil-outline' : 'mdi-plus-circle-outline' }}</v-icon>
          </div>
          <h3>{{ mode === 'edit' ? t('asset.edit') : t('asset.create') }}</h3>
          <button class="action-btn" @click="close">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>
        <div class="modal-body">
          <div class="type-grid">
            <div class="type-card" @click="selectType('ssh')">
              <div class="type-icon ssh">
                <v-icon size="26">mdi-console</v-icon>
              </div>
              <div class="type-meta">
                <span class="type-name">SSH</span>
                <span class="type-desc">{{ t('ssh.terminal') }} · {{ t('sftp.title') }}</span>
              </div>
              <v-icon class="arrow" size="14">mdi-arrow-right</v-icon>
            </div>
            <div class="type-card disabled">
              <div class="type-icon db">
                <v-icon size="26">mdi-database-outline</v-icon>
              </div>
              <div class="type-meta">
                <span class="type-name">{{ t('db.title') }}</span>
                <span class="type-desc">MySQL · PG · Redis · ...</span>
              </div>
              <span class="cyber-badge" style="color: var(--muted); border-color: var(--line-2);">SOON</span>
            </div>
            <div class="type-card disabled">
              <div class="type-icon docker">
                <v-icon size="26">mdi-docker</v-icon>
              </div>
              <div class="type-meta">
                <span class="type-name">Docker</span>
                <span class="type-desc">{{ t('docker.containers') }} / {{ t('docker.images') }}</span>
              </div>
              <span class="cyber-badge" style="color: var(--muted); border-color: var(--line-2);">SOON</span>
            </div>
          </div>
        </div>
      </template>

      <!-- SSH Form -->
      <template v-else-if="step === 'ssh'">
        <div class="modal-header">
          <button class="action-btn" @click="step = 'type'" style="margin-right: -4px;">
            <v-icon size="14">mdi-arrow-left</v-icon>
          </button>
          <div class="icon-box">
            <v-icon size="14">mdi-console</v-icon>
          </div>
          <h3>
            {{ mode === 'edit' ? t('asset.edit') : t('asset.create') }} · SSH
            <span v-if="mode === 'edit' && asset" class="edit-hint">{{ asset.name }}</span>
          </h3>
          <button class="action-btn" @click="close">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>
        <div class="modal-body">
          <SshConnectionForm
            :initial-values="mode === 'edit' && asset ? {
              name: asset.name,
              host: asset.config.host || '',
              port: asset.config.port || 22,
              username: asset.config.username || '',
              password: asset.config.password || '',
              privateKey: asset.config.privateKey || '',
              passphrase: asset.config.passphrase || ''
            } : undefined"
            @submit="handleSshSubmit"
            @cancel="close"
          />
        </div>
      </template>
    </div>
  </v-dialog>
</template>

<style scoped>
.new-conn-dialog {
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 16px;
  overflow: hidden;
  position: relative;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px -12px rgba(0, 0, 0, 0.7);
}

.new-conn-dialog::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--grad-primary);
  opacity: 0.6;
  pointer-events: none;
  z-index: 1;
}

.edit-hint {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
  background: rgba(0, 240, 255, 0.08);
  border: 1px solid var(--line-2);
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 4px;
}

.type-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.type-card {
  background: rgba(20, 25, 40, 0.6);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  align-items: center;
  gap: 14px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.type-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0;
  transition: opacity 0.25s;
}

.type-card:hover:not(.disabled) {
  background: rgba(0, 240, 255, 0.04);
  border-color: rgba(0, 240, 255, 0.3);
  transform: translateX(2px);
  box-shadow: 0 4px 16px rgba(0, 240, 255, 0.12);
}

.type-card:hover:not(.disabled)::before {
  opacity: 0.5;
}

.type-card.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.type-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.type-icon.ssh {
  background: rgba(0, 240, 255, 0.1);
  color: var(--cyan);
  border: 1px solid rgba(0, 240, 255, 0.2);
}

.type-icon.db {
  background: rgba(181, 107, 255, 0.1);
  color: var(--purple);
  border: 1px solid rgba(181, 107, 255, 0.2);
}

.type-icon.docker {
  background: rgba(74, 222, 128, 0.1);
  color: var(--green);
  border: 1px solid rgba(74, 222, 128, 0.2);
}

.type-meta {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.type-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.type-desc {
  font-size: 12px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}

.type-card .arrow {
  color: var(--muted);
  opacity: 0;
  transform: translateX(-4px);
  transition: all 0.25s;
}

.type-card:hover:not(.disabled) .arrow {
  opacity: 1;
  transform: translateX(0);
  color: var(--cyan);
}
</style>
