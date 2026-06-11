<script setup lang="ts">
import { ref, computed } from 'vue'

export interface HostKeyInfo {
  hostname: string
  port: number
  remote: string
  keyType: string
  sha256: string
  sha1?: string
  md5?: string
}

const data = ref<HostKeyInfo | null>(null)
let resolvePromise: ((value: 'allow' | 'persist' | 'reject') => void) | null = null

function open(info: HostKeyInfo): Promise<'allow' | 'persist' | 'reject'> {
  return new Promise((resolve) => {
    resolvePromise = resolve
    data.value = info
  })
}

function resolve(value: 'allow' | 'persist' | 'reject') {
  data.value = null
  resolvePromise?.(value)
  resolvePromise = null
}

function handleReject() { resolve('reject') }
function handleAllow() { resolve('allow') }
function handlePersist() { resolve('persist') }

defineExpose({ open })

const visible = computed(() => data.value !== null)
</script>

<template>
  <v-dialog :model-value="visible" persistent max-width="480" @keydown.esc="handleReject">
    <div class="hostkey-dialog" v-if="data">
      <div class="hk-header">
        <div class="hk-title">
          <v-icon size="20" color="var(--cyan)">mdi-shield-key-outline</v-icon>
          <span>Host Key Verification</span>
        </div>
        <div class="hk-subtitle">{{ data.hostname }}:{{ data.port }}</div>
      </div>

      <div class="hk-body">
        <div class="hk-warning">
          <v-icon size="14">mdi-alert-outline</v-icon>
          <span>The host key for this server is not in the known_hosts file. Verify the fingerprint before accepting.</span>
        </div>

        <div class="hk-table">
          <div class="hk-row">
            <span class="hk-label">HOST</span>
            <span class="hk-value">{{ data.remote }}</span>
          </div>
          <div class="hk-row">
            <span class="hk-label">TYPE</span>
            <span class="hk-value">{{ data.keyType }}</span>
          </div>
          <div class="hk-row">
            <span class="hk-label">SHA256</span>
            <span class="hk-value hk-fingerprint">{{ data.sha256 }}</span>
          </div>
          <div class="hk-row" v-if="data.sha1">
            <span class="hk-label">SHA1</span>
            <span class="hk-value hk-fingerprint">{{ data.sha1 }}</span>
          </div>
          <div class="hk-row" v-if="data.md5">
            <span class="hk-label">MD5</span>
            <span class="hk-value hk-fingerprint">{{ data.md5 }}</span>
          </div>
        </div>
      </div>

      <div class="hk-footer">
        <button type="button" class="cyber-btn-secondary" @click="handleReject">
          <v-icon size="14">mdi-close</v-icon>
          Reject
        </button>
        <button type="button" class="cyber-btn" @click="handleAllow">
          <v-icon size="14">mdi-check</v-icon>
          Allow
        </button>
        <button type="button" class="hk-btn-accept" @click="handlePersist">
          <v-icon size="14">mdi-check-circle</v-icon>
          Allow &amp; Remember
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.hostkey-dialog {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: var(--shadow), 0 0 40px rgba(0, 240, 255, 0.08);
}

.hk-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-solid);
}

.hk-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.hk-subtitle {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  margin-top: 4px;
  margin-left: 28px;
}

.hk-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hk-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--yellow);
  line-height: 1.5;
  padding: 10px 12px;
  background: rgba(250, 204, 21, 0.06);
  border: 1px solid rgba(250, 204, 21, 0.15);
  border-radius: 8px;
}

.hk-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--panel-solid-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px;
  overflow: hidden;
}

.hk-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 4px;
}

.hk-row:nth-child(even) {
  background: var(--hover-cyan-faint);
}

.hk-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  min-width: 56px;
  flex-shrink: 0;
}

.hk-value {
  font-size: 12px;
  color: var(--text-2);
  font-family: 'JetBrains Mono', monospace;
  word-break: break-all;
  line-height: 1.5;
}

.hk-fingerprint {
  font-size: 11px;
  color: var(--text);
  letter-spacing: 0.02em;
}

.hk-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--bg-modal-footer);
}

.hk-btn-accept {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  color: var(--bg);
  background: var(--grad-success);
  border: none;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 4px 16px var(--glow-soft);
}

.hk-btn-accept:hover {
  transform: translateY(-2px);
  box-shadow: 0 0 20px rgba(74, 222, 128, 0.5), 0 0 40px rgba(74, 222, 128, 0.2);
}
</style>
