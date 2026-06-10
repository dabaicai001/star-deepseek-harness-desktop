<script setup lang="ts">
import { ref, watch } from 'vue'
import * as dbService from '@/services/db'

const props = defineProps<{
  connId: string
  db: string
  table: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
}>()

const ddl = ref('')
const loading = ref(false)
const error = ref<string | null>(null)

watch(() => props.modelValue, async (v) => {
  if (!v) return
  loading.value = true
  error.value = null
  try {
    const r = await dbService.mysqlGetTableDDL(props.connId, props.table, props.db)
    ddl.value = r.ddl
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
    ddl.value = ''
  } finally {
    loading.value = false
  }
})

function copyDDL() {
  navigator.clipboard.writeText(ddl.value).catch(() => {})
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="720">
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--cyan)">mdi-code-tags</v-icon>
        <span class="dialog-title">CREATE TABLE</span>
        <span class="dialog-subtitle">{{ db }}.{{ table }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="emit('update:modelValue', false)" />
      </div>

      <div v-if="loading" class="dialog-loading">
        <v-icon size="20" class="spin">mdi-loading</v-icon>
        Loading...
      </div>

      <template v-else>
        <div v-if="error" class="dialog-error">{{ error }}</div>
        <pre v-else class="ddl-content">{{ ddl }}</pre>
      </template>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="emit('update:modelValue', false)">Close</button>
        <button v-if="ddl" class="cyber-btn" @click="copyDDL">
          <v-icon size="14">mdi-content-copy</v-icon> Copy
        </button>
      </div>
    </div>
  </v-dialog>
</template>

<style scoped>
.dialog-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); flex-shrink: 0;
}
.dialog-title { font-weight: 600; font-size: 14px; color: var(--text); }
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-loading { padding: 16px; text-align: center; }
.dialog-error { padding: 12px 16px; color: var(--red); font-size: 12px; }
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}
.ddl-content {
  padding: 16px; font-size: 12px; font-family: 'JetBrains Mono', monospace;
  color: var(--text); white-space: pre-wrap; word-break: break-all;
  background: var(--panel-solid); max-height: 60vh; overflow: auto; margin: 0;
}
.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
