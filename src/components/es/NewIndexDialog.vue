<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import * as esService from '@/services/db'

const { t } = useI18n()

const props = defineProps<{
  connId: string
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  created: [indexName: string]
}>()

const indexName = ref('')
const shards = ref(1)
const replicas = ref(1)
const creating = ref(false)
const error = ref<string | null>(null)

const canCreate = computed(() => indexName.value.trim())

async function onCreate() {
  if (!canCreate.value) return
  creating.value = true
  error.value = null

  try {
    const settings: Record<string, unknown> = {
      number_of_shards: shards.value,
      number_of_replicas: replicas.value,
    }
    await esService.esCreateIndex(props.connId, indexName.value, undefined, settings)
    emit('created', indexName.value)
    emit('update:modelValue', false)
    resetForm()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

function resetForm() {
  indexName.value = ''
  shards.value = 1
  replicas.value = 1
  error.value = null
}

function onCancel() {
  emit('update:modelValue', false)
  resetForm()
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="480" persistent>
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--cyan)">mdi-database-plus</v-icon>
        <span class="dialog-title">{{ t('es.newIndex', '新建索引') }}</span>
        <v-spacer />
        <v-btn variant="text" size="small" icon="mdi-close" @click="onCancel" />
      </div>

      <div class="dialog-body">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">{{ t('es.indexName', '索引名称') }} <span class="required">*</span></label>
          <input v-model="indexName" class="cyber-input" :placeholder="t('es.indexNamePlaceholder', '例如 my-index')" autofocus />
        </div>

        <div class="form-row-group">
          <div class="form-row half">
            <label class="form-label">{{ t('es.shards', '主分片数') }}</label>
            <input v-model.number="shards" type="number" class="cyber-input" min="1" max="100" />
          </div>
          <div class="form-row half">
            <label class="form-label">{{ t('es.replicas', '副本数') }}</label>
            <input v-model.number="replicas" type="number" class="cyber-input" min="0" max="100" />
          </div>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="cyber-btn-secondary" @click="onCancel">{{ t('common.cancel') }}</button>
        <button class="cyber-btn" :disabled="!canCreate || creating" @click="onCreate">
          <v-icon v-if="creating" size="14" class="spin">mdi-loading</v-icon>
          <v-icon v-else size="14">mdi-check</v-icon>
          {{ t('common.create', '创建') }}
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
.dialog-body { padding: 16px; }
.dialog-error {
  padding: 8px 12px; margin-bottom: 12px;
  background: rgba(255, 80, 80, 0.1); border: 1px solid rgba(255, 80, 80, 0.3);
  border-radius: 6px; color: var(--red); font-size: 12px;
}
.dialog-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--line); flex-shrink: 0;
}

.form-row { margin-bottom: 12px; }
.form-label {
  display: block; font-size: 11px; color: var(--text-2);
  margin-bottom: 4px; font-weight: 500;
}
.required { color: var(--red); }
.form-row-group { display: flex; gap: 12px; margin-bottom: 12px; }
.form-row.half { flex: 1; margin-bottom: 0; }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
