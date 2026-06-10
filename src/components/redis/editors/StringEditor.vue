<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import * as dbService from '@/services/db'

const props = defineProps<{
  connId: string
  keyName: string
  keyType: string
  isNew: boolean
}>()

const emit = defineEmits<{
  dirty: [value: boolean]
  saved: []
}>()

const value = ref('')
const originalValue = ref('')
const loading = ref(false)
const saving = ref(false)
const ttl = ref(-1)
const ttlInput = ref('')
const viewMode = ref<'text' | 'json'>('text')
const error = ref('')
const size = ref(0)

const isDirty = computed(() => value.value !== originalValue.value || (props.isNew && value.value !== ''))
watch(isDirty, (v) => emit('dirty', v))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await dbService.redisGetValue(props.connId, props.keyName)
    const raw = result.value
    if (typeof raw === 'string') {
      value.value = raw
    } else if (raw !== null && raw !== undefined) {
      value.value = JSON.stringify(raw, null, 2)
      viewMode.value = 'json'
    } else {
      value.value = ''
    }
    originalValue.value = value.value
    ttl.value = result.ttl ?? -1
    ttlInput.value = ttl.value === -1 ? '' : String(ttl.value)
    size.value = result.size ?? new TextEncoder().encode(value.value).length
    if (viewMode.value === 'text') {
      try { JSON.parse(value.value); viewMode.value = 'json' } catch { /* not json */ }
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const expiration = ttlInput.value ? Number(ttlInput.value) : undefined
    await dbService.redisSet(props.connId, props.keyName, value.value, expiration)
    originalValue.value = value.value
    if (ttlInput.value) ttl.value = Number(ttlInput.value)
    emit('saved')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function formatJson() {
  try {
    const parsed = JSON.parse(value.value)
    value.value = JSON.stringify(parsed, null, 2)
  } catch { /* not valid json */ }
}

function revert() {
  value.value = originalValue.value
  error.value = ''
}

function onViewModeChange(mode: 'text' | 'json') {
  if (mode === 'json') {
    try { JSON.parse(value.value); viewMode.value = 'json' } catch { return }
  } else {
    viewMode.value = 'text'
  }
}

load()
</script>

<template>
  <div class="string-editor">
    <div class="editor-info-bar">
      <div class="info-left">
        <v-icon size="14" style="color: var(--green)">mdi-format-text</v-icon>
        <span class="info-key" :title="keyName">{{ keyName }}</span>
        <span class="cyber-badge">STRING</span>
      </div>
      <div class="info-right">
        <span class="info-item">
          <span class="info-label">TTL</span>
          <input
            class="ttl-input"
            v-model="ttlInput"
            :placeholder="ttl === -1 ? '-1 (persist)' : String(ttl)"
            type="number"
            style="width: 80px"
          />
        </span>
        <span class="info-item">
          <span class="info-label">Size</span>
          <span class="info-value mono">{{ size }} B</span>
        </span>
      </div>
    </div>

    <div class="editor-toolbar">
      <div class="toolbar-tabs">
        <button
          class="cyber-tab"
          :class="{ active: viewMode === 'text' }"
          @click="onViewModeChange('text')"
        >Text</button>
        <button
          class="cyber-tab"
          :class="{ active: viewMode === 'json' }"
          @click="onViewModeChange('json')"
        >JSON</button>
      </div>
      <div class="toolbar-actions">
        <button
          class="action-btn"
          @click="formatJson"
          data-tooltip="Format JSON"
          :disabled="viewMode !== 'json'"
        >
          <v-icon size="15">mdi-code-braces</v-icon>
        </button>
        <button class="action-btn" @click="load" data-tooltip="Reload" :disabled="loading">
          <v-icon size="15">mdi-refresh</v-icon>
        </button>
      </div>
    </div>

    <div v-if="loading" class="editor-loading">
      <v-icon size="20" style="color: var(--muted); animation: pulse 1s infinite">mdi-loading</v-icon>
      <span>Loading...</span>
    </div>

    <div v-else-if="error" class="editor-error">
      <v-icon size="18" style="color: var(--red)">mdi-alert-circle</v-icon>
      <span>{{ error }}</span>
    </div>

    <textarea
      v-else
      class="editor-area"
      v-model="value"
      :spellcheck="false"
      placeholder="Value..."
    ></textarea>

    <div class="editor-footer">
      <span v-if="error" class="footer-error">{{ error }}</span>
      <span v-else class="footer-spacer"></span>
      <button class="cyber-btn-secondary" @click="revert" :disabled="!isDirty">Revert</button>
      <button class="cyber-btn" @click="save" :disabled="!isDirty || saving">
        <v-icon v-if="saving" size="14" style="animation: pulse 1s infinite">mdi-loading</v-icon>
        <v-icon v-else size="14">mdi-content-save</v-icon>
        Save
      </button>
    </div>
  </div>
</template>

<style scoped>
.string-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

.editor-info-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 12px; border-bottom: 1px solid var(--line); flex-shrink: 0;
  min-height: 36px; gap: 12px; flex-wrap: wrap;
}
.info-left { display: flex; align-items: center; gap: 8px; }
.info-key { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 600; color: var(--text); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.info-right { display: flex; align-items: center; gap: 16px; font-size: 11px; color: var(--text-2); }
.info-item { display: flex; align-items: center; gap: 6px; }
.info-label { font-family: 'Outfit', sans-serif; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.info-value { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-2); }
.ttl-input {
  background: var(--bg-input); border: 1px solid var(--line-2); border-radius: 4px;
  color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 11px;
  padding: 2px 6px; width: 80px; outline: none;
}
.ttl-input:focus { border-color: var(--cyan); }

.editor-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 8px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.toolbar-tabs { display: flex; }
.toolbar-actions { display: flex; align-items: center; gap: 2px; padding-right: 4px; }

.editor-loading {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--muted); font-size: 13px;
}
.editor-error {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--red); font-size: 13px; padding: 0 24px; text-align: center;
}

.editor-area {
  flex: 1; min-height: 0; padding: 12px; border: none; outline: none; resize: none;
  background: var(--panel-solid-2); color: var(--text);
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px;
  line-height: 1.6; tab-size: 2;
}
.editor-area::placeholder { color: var(--muted); }

.editor-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 8px 12px; border-top: 1px solid var(--line); flex-shrink: 0;
  background: var(--panel-solid); min-height: 40px;
}
.footer-spacer { flex: 1; }
.footer-error { font-size: 11px; color: var(--red); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: 'JetBrains Mono', monospace; }
</style>
