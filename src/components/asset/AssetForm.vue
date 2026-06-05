<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AssetType, DatabaseType, CreateAssetDto } from '@/types/asset'

const { t } = useI18n()

const emit = defineEmits<{
  submit: [dto: CreateAssetDto]
  cancel: []
}>()

const assetType = ref<AssetType>('ssh')
const name = ref('')
const host = ref('')
const port = ref(22)
const username = ref('')
const password = ref('')
const database = ref('')
const dbType = ref<DatabaseType>('mysql')
const socketPath = ref('')
const showPassword = ref(false)

const portLabel = computed(() => {
  switch (assetType.value) {
    case 'ssh': return '22'
    case 'db': return portForDb(dbType.value)
    case 'docker': return '2375'
    default: return ''
  }
})

function portForDb(type: DatabaseType) {
  switch (type) {
    case 'mysql': return '3306'
    case 'postgresql': return '5432'
    case 'sqlite': return ''
    case 'redis': return '6379'
    default: return '3306'
  }
}

watch(assetType, (newType) => {
  if (newType === 'ssh') port.value = 22
  else if (newType === 'db') port.value = 3306
  else if (newType === 'docker') port.value = 2375
})

watch(dbType, (newDb) => {
  port.value = portForDb(newDb) ? Number(portForDb(newDb)) : 0
})

const canSubmit = computed(() => {
  if (!name.value) return false
  if (assetType.value === 'docker') return Boolean(host.value || socketPath.value)
  return Boolean(host.value)
})

function onSubmit() {
  if (!canSubmit.value) return
  const dto: CreateAssetDto = {
    type: assetType.value,
    name: name.value,
    config: {
      host: host.value || undefined,
      port: port.value || undefined,
      username: username.value || undefined,
      password: password.value || undefined,
      database: database.value || undefined,
      dbType: assetType.value === 'db' ? dbType.value : undefined,
      socketPath: socketPath.value || undefined
    }
  }
  emit('submit', dto)
}

function onCancel() {
  emit('cancel')
}
</script>

<template>
  <form class="asset-form" @submit.prevent="onSubmit">
    <!-- 类型切换 -->
    <div class="form-field">
      <label class="field-label">
        <v-icon size="12">mdi-shape-outline</v-icon>
        {{ t('asset.type') }}
        <span class="optional">Type</span>
      </label>
      <div class="switcher" role="tablist">
        <div
          class="switcher-item"
          :class="{ active: assetType === 'ssh' }"
          @click="assetType = 'ssh'"
          role="tab"
        >
          <v-icon size="14">mdi-console</v-icon>
          SSH
        </div>
        <div
          class="switcher-item"
          :class="{ active: assetType === 'db' }"
          @click="assetType = 'db'"
          role="tab"
        >
          <v-icon size="14">mdi-database-outline</v-icon>
          {{ t('db.title') }}
        </div>
        <div
          class="switcher-item"
          :class="{ active: assetType === 'docker' }"
          @click="assetType = 'docker'"
          role="tab"
        >
          <v-icon size="14">mdi-docker</v-icon>
          Docker
        </div>
      </div>
    </div>

    <!-- 名称 -->
    <div class="form-field">
      <label class="field-label">
        <v-icon size="12">mdi-tag-outline</v-icon>
        {{ t('asset.name') }}
        <span class="required">*</span>
      </label>
      <input
        v-model="name"
        type="text"
        class="cyber-input"
        :placeholder="t('asset.placeholderName')"
        required
        autofocus
      />
    </div>

    <!-- SSH / DB: Host:Port -->
    <template v-if="assetType !== 'docker'">
      <div class="form-field">
        <label class="field-label">
          <v-icon size="12">mdi-server-network</v-icon>
          {{ assetType === 'db' ? t('asset.server') : t('asset.host') }}
          <span class="required">*</span>
        </label>
        <div class="form-row host-port">
          <input
            v-model="host"
            type="text"
            class="cyber-input"
            :placeholder="assetType === 'db' ? t('asset.placeholderDb') : t('asset.placeholderHost')"
            required
          />
          <input
            v-model.number="port"
            type="number"
            class="cyber-input mono"
            :placeholder="portLabel"
          />
        </div>
      </div>

      <div v-if="assetType === 'db'" class="form-field">
        <label class="field-label">
          <v-icon size="12">mdi-database</v-icon>
          {{ t('asset.dbType') }}
        </label>
        <div class="switcher" role="tablist">
          <div
            v-for="type in ['mysql', 'postgresql', 'redis'] as DatabaseType[]"
            :key="type"
            class="switcher-item"
            :class="{ active: dbType === type }"
            @click="dbType = type"
            role="tab"
          >
            {{ type }}
          </div>
        </div>
      </div>

      <div v-if="assetType === 'db'" class="form-field">
        <label class="field-label">
          <v-icon size="12">mdi-database-search-outline</v-icon>
          {{ t('asset.database') }}
          <span class="optional">{{ t('db.initialDbHint') }}</span>
        </label>
        <input
          v-model="database"
          type="text"
          class="cyber-input"
          :placeholder="t('asset.placeholderDatabase')"
        />
      </div>

      <div v-if="assetType === 'ssh'" class="form-field">
        <label class="field-label">
          <v-icon size="12">mdi-account-outline</v-icon>
          {{ t('asset.username') }}
          <span class="required">*</span>
        </label>
        <div class="input-group">
          <span class="input-prefix">@</span>
          <input
            v-model="username"
            type="text"
            class="cyber-input"
            :placeholder="t('asset.placeholderUser')"
          />
        </div>
      </div>
    </template>

    <!-- Docker: socket path -->
    <template v-else>
      <div class="form-field">
        <label class="field-label">
          <v-icon size="12">mdi-link-variant</v-icon>
          {{ t('asset.dockerSocket') }}
        </label>
        <input
          v-model="socketPath"
          type="text"
          class="cyber-input mono"
          placeholder="/var/run/docker.sock  or  tcp://192.168.1.10:2375"
        />
        <div class="field-hint">{{ t('asset.dockerSocketHint') }}</div>
      </div>
    </template>

    <!-- 密码 -->
    <div v-if="assetType !== 'docker'" class="form-field">
      <label class="field-label">
        <v-icon size="12">mdi-lock-outline</v-icon>
        {{ t('asset.password') }}
        <span class="optional">{{ t('ssh.passwordOptional') }}</span>
      </label>
      <div class="input-group">
          <v-icon class="input-prefix" size="13">mdi-lock-outline</v-icon>
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="cyber-input"
            placeholder="••••••••"
            autocomplete="off"
          />
          <button
            type="button"
            class="input-suffix-btn"
            @click="showPassword = !showPassword"
          >
            <v-icon size="14">{{ showPassword ? 'mdi-eye-off' : 'mdi-eye' }}</v-icon>
          </button>
        </div>
    </div>

    <!-- Footer -->
    <div class="form-footer">
      <div class="spacer" />
      <button type="button" class="cyber-btn-secondary" @click="onCancel">
        <v-icon size="14">mdi-close</v-icon>
        {{ t('common.cancel') }}
      </button>
      <button
        type="submit"
        class="cyber-btn"
        :disabled="!canSubmit"
        :style="{ opacity: canSubmit ? 1 : 0.4, cursor: canSubmit ? 'pointer' : 'not-allowed' }"
      >
        <v-icon size="14">mdi-content-save-outline</v-icon>
        {{ t('common.save') }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.asset-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-field {
  display: flex;
  flex-direction: column;
}
</style>
