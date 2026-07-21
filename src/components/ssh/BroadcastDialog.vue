<script setup lang="ts">
import { ref, computed } from 'vue'

export interface BroadcastSession {
  sessionId: string
  title: string
  host: string
}

interface BroadcastResult {
  command: string
  sessionIds: string[]
}

const sessions = ref<BroadcastSession[]>([])
const selectedIds = ref<Set<string>>(new Set())
const command = ref('')
let resolvePromise: ((value: BroadcastResult | null) => void) | null = null

function open(sessionList: BroadcastSession[]): Promise<BroadcastResult | null> {
  return new Promise((resolve) => {
    resolvePromise = resolve
    sessions.value = sessionList
    selectedIds.value = new Set(sessionList.map((s) => s.sessionId))
    command.value = ''
  })
}

function toggleSession(sessionId: string) {
  const next = new Set(selectedIds.value)
  if (next.has(sessionId)) {
    next.delete(sessionId)
  } else {
    next.add(sessionId)
  }
  selectedIds.value = next
}

function selectAll() {
  selectedIds.value = new Set(sessions.value.map((s) => s.sessionId))
}

function deselectAll() {
  selectedIds.value = new Set()
}

function handleSend() {
  const result: BroadcastResult = {
    command: command.value,
    sessionIds: [...selectedIds.value],
  }
  sessions.value = []
  resolvePromise?.(result)
  resolvePromise = null
}

function handleCancel() {
  sessions.value = []
  resolvePromise?.(null)
  resolvePromise = null
}

defineExpose({ open })

const visible = computed(() => sessions.value.length > 0)
const allSelected = computed(
  () => sessions.value.length > 0 && selectedIds.value.size === sessions.value.length
)
const noneSelected = computed(() => selectedIds.value.size === 0)
</script>

<template>
  <v-dialog :model-value="visible" persistent max-width="520" @keydown.esc="handleCancel">
    <div class="broadcast-dialog" v-if="visible">
      <div class="bd-header">
        <div class="bd-title">
          <v-icon size="20" color="var(--cyan)">mdi-broadcast</v-icon>
          <span>Broadcast Command</span>
        </div>
        <div class="bd-subtitle">
          {{ selectedIds.size }} of {{ sessions.length }} sessions selected
        </div>
      </div>

      <div class="bd-body">
        <div class="bd-select-actions">
          <button type="button" class="cyber-btn-secondary bd-select-btn" @click="selectAll">
            <v-icon size="12">mdi-checkbox-multiple-marked</v-icon>
            Select All
          </button>
          <button type="button" class="cyber-btn-secondary bd-select-btn" @click="deselectAll">
            <v-icon size="12">mdi-checkbox-multiple-blank</v-icon>
            Deselect All
          </button>
        </div>

        <div class="bd-session-list">
          <div
            v-for="session in sessions"
            :key="session.sessionId"
            class="bd-session-row"
            :class="{ selected: selectedIds.has(session.sessionId) }"
            @click="toggleSession(session.sessionId)"
          >
            <div class="bd-checkbox">
              <v-icon size="16">
                {{ selectedIds.has(session.sessionId) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline' }}
              </v-icon>
            </div>
            <div class="bd-session-info">
              <div class="bd-session-title">{{ session.title }}</div>
              <div class="bd-session-host">{{ session.host }}</div>
            </div>
          </div>
        </div>

        <div class="bd-command-input">
          <label class="field-label">
            <v-icon size="11">mdi-console-line</v-icon>
            Command
          </label>
          <input
            v-model="command"
            type="text"
            class="cyber-input"
            placeholder="Enter command to broadcast..."
            @keydown.enter="handleSend"
          />
        </div>

        <div class="bd-warning">
          <v-icon size="14">mdi-alert-outline</v-icon>
          <span>This will send the command to all selected sessions simultaneously. Use with caution.</span>
        </div>
      </div>

      <div class="bd-footer">
        <button type="button" class="cyber-btn-secondary" @click="handleCancel">
          <v-icon size="14">mdi-close</v-icon>
          Cancel
        </button>
        <button
          type="button"
          class="cyber-btn"
          :disabled="!command.trim() || noneSelected"
          @click="handleSend"
        >
          <v-icon size="14">mdi-broadcast</v-icon>
          Send
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.broadcast-dialog {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
  color: var(--text);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: var(--shadow), var(--glow-soft);
}

.bd-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-solid);
}

.bd-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.bd-subtitle {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  margin-top: 4px;
  margin-left: 28px;
}

.bd-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bd-select-actions {
  display: flex;
  gap: 8px;
}

.bd-select-btn {
  font-size: 11px;
  padding: 5px 10px;
}

.bd-session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
  background: var(--panel-solid-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px;
}

.bd-session-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.bd-session-row:hover {
  background: var(--hover-cyan-soft);
}

.bd-session-row.selected {
  background: var(--hover-cyan);
}

.bd-checkbox {
  color: var(--muted);
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.bd-session-row.selected .bd-checkbox {
  color: var(--cyan);
}

.bd-session-info {
  min-width: 0;
}

.bd-session-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bd-session-host {
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bd-command-input {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bd-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11px;
  color: var(--yellow);
  line-height: 1.5;
  padding: 8px 10px;
  background: rgba(250, 204, 21, 0.06);
  border: 1px solid rgba(250, 204, 21, 0.15);
  border-radius: 6px;
}

.bd-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--bg-modal-footer);
}
</style>
