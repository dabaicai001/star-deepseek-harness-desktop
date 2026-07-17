<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import * as dbService from '@/services/db'

const { t } = useI18n()

const props = defineProps<{
  connId: string
  currentDb: number
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  created: [key: string, type: string]
}>()

const keyName = ref('')
const keyType = ref('string')
const keyValue = ref('')
const hashField = ref('')
const ttl = ref(0)
const creating = ref(false)
const error = ref<string | null>(null)

const canCreate = computed(() => {
  return keyName.value.trim() && (keyType.value === 'string' ? keyValue.value : true)
})

const keyTypes = [
  { value: 'string', label: 'String', icon: 'mdi-format-text' },
  { value: 'hash', label: 'Hash', icon: 'mdi-pound' },
  { value: 'list', label: 'List', icon: 'mdi-format-list-bulleted' },
  { value: 'set', label: 'Set', icon: 'mdi-set-center' },
  { value: 'zset', label: 'Sorted Set', icon: 'mdi-sort-numeric-ascending' },
]

async function onCreate() {
  if (!canCreate.value) return
  creating.value = true
  error.value = null

  try {
    let cmd = ''
    switch (keyType.value) {
      case 'string':
        cmd = `SET "${keyName.value}" "${keyValue.value}"`
        break
      case 'hash':
        if (hashField.value && keyValue.value) {
          cmd = `HSET "${keyName.value}" "${hashField.value}" "${keyValue.value}"`
        } else {
          error.value = t('redis.hashFieldRequired', 'Hash field and value are required')
          creating.value = false
          return
        }
        break
      case 'list':
        cmd = `RPUSH "${keyName.value}" "${keyValue.value}"`
        break
      case 'set':
        cmd = `SADD "${keyName.value}" "${keyValue.value}"`
        break
      case 'zset':
        cmd = `ZADD "${keyName.value}" 0 "${keyValue.value}"`
        break
    }

    if (ttl.value > 0) {
      cmd += `\nEXPIRE "${keyName.value}" ${ttl.value}`
    }

    await dbService.redisExecute(props.connId, cmd)
    emit('created', keyName.value, keyType.value)
    emit('update:modelValue', false)
    resetForm()
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

function resetForm() {
  keyName.value = ''
  keyType.value = 'string'
  keyValue.value = ''
  hashField.value = ''
  ttl.value = 0
  error.value = null
}

function onCancel() {
  emit('update:modelValue', false)
  resetForm()
}
</script>

<template>
  <v-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" max-width="520" persistent>
    <div class="cyber-panel" style="padding: 0;">
      <div class="dialog-header">
        <v-icon size="16" color="var(--cyan)">mdi-key-plus</v-icon>
        <span class="dialog-title">{{ t('redis.newKey', '新建 Key') }}</span>
        <span class="dialog-subtitle">db{{ currentDb }}</span>
        <v-spacer />
        <button class="action-btn" @click="onCancel">
            <v-icon size="16">mdi-close</v-icon>
          </button>
      </div>

      <div class="dialog-body">
        <div v-if="error" class="dialog-error">{{ error }}</div>

        <div class="form-row">
          <label class="form-label">{{ t('redis.keyName', 'Key 名称') }} <span class="required">*</span></label>
          <input v-model="keyName" class="cyber-input" :placeholder="t('redis.keyNamePlaceholder', '例如 user:alice')" autofocus />
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('redis.keyType', '类型') }}</label>
          <div class="type-chips">
            <button
              v-for="kt in keyTypes"
              :key="kt.value"
              class="type-chip"
              :class="{ active: keyType === kt.value }"
              @click="keyType = kt.value"
            >
              <v-icon size="12">{{ kt.icon }}</v-icon>
              {{ kt.label }}
            </button>
          </div>
        </div>

        <div v-if="keyType === 'hash'" class="form-row">
          <label class="form-label">{{ t('redis.hashField', 'Hash Field') }} <span class="required">*</span></label>
          <input v-model="hashField" class="cyber-input" placeholder="field" />
        </div>

        <div class="form-row">
          <label class="form-label">{{ t('redis.keyValue', '值') }} <span v-if="keyType === 'string'" class="required">*</span></label>
          <textarea v-model="keyValue" class="cyber-input" rows="3" :placeholder="t('redis.keyValuePlaceholder', '输入值...')" />
        </div>

        <div class="form-row">
          <label class="form-label">TTL ({{ t('redis.seconds', '秒') }})</label>
          <input v-model.number="ttl" type="number" class="cyber-input" placeholder="0 = 永不过期" min="0" />
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
.dialog-subtitle { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.dialog-body { padding: 16px; max-height: 65vh; overflow: auto; }
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

.type-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.type-chip {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 10px; border-radius: 6px;
  border: 1px solid var(--line); background: transparent;
  color: var(--text-2); font-size: 11px; cursor: pointer;
  transition: all 0.15s;
}
.type-chip:hover { border-color: var(--cyan); color: var(--cyan); }
.type-chip.active {
  border-color: var(--cyan); background: rgba(0, 240, 255, 0.1); color: var(--cyan);
}

textarea.cyber-input { resize: vertical; min-height: 60px; }

.spin { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
</style>
