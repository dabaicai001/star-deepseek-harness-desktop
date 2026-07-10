<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CreateAssetDto, DatabaseType } from '@/types/asset'
import * as dbService from '@/services/db'
import { testBroker } from '@/services/broker'
import ProductIcon from '@/components/common/ProductIcon.vue'

const { t } = useI18n()

// 跨平台快捷键修饰键(Mac ⌘, Win/Linux Ctrl)
const isMac = ref(false)
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')
onMounted(() => {
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = /mac|iphone|ipad|ipod/.test(ua)
})

export interface DbFormInitialValues {
  name?: string
  dbType?: DatabaseType
  address?: string
  addresses?: string[]
  host?: string
  port?: number
  username?: string
  password?: string
  database?: string
  ssl?: boolean
  redisDb?: number
}

const props = defineProps<{
  initialValues?: DbFormInitialValues
}>()

const emit = defineEmits<{
  submit: [dto: CreateAssetDto]
  cancel: []
}>()

const dbType = ref<DatabaseType>(props.initialValues?.dbType ?? 'mysql')
const name = ref(props.initialValues?.name ?? '')
const esConnectMode = ref<'host' | 'address' | 'multi'>(props.initialValues?.address ? 'address' : props.initialValues?.addresses?.length ? 'multi' : 'host')
const esAddress = ref(props.initialValues?.address ?? '')
const esNodes = ref<string>(props.initialValues?.addresses?.join('\n') ?? '')
const host = ref(props.initialValues?.host ?? '')
const port = ref<number>(props.initialValues?.port ?? 3306)
const username = ref(props.initialValues?.username ?? '')
const password = ref(props.initialValues?.password ?? '')
const database = ref(props.initialValues?.database ?? '')
const ssl = ref(props.initialValues?.ssl ?? false)
const redisDb = ref<number>(props.initialValues?.redisDb ?? 0)
const esApiKey = ref('')
const esAuthMode = ref<'password' | 'apikey'>('password')
const showPassword = ref(false)

const testStatus = ref<'idle' | 'testing' | 'success' | 'fail'>('idle')
const testMessage = ref('')

watch(dbType, (type) => {
  if (type === 'mysql') {
    port.value = 3306
  } else if (type === 'redis') {
    port.value = 6379
  } else if (type === 'elasticsearch') {
    port.value = 9200
    if (esAddress.value) esConnectMode.value = 'address'
  } else if (type === 'clickhouse') {
    port.value = 9000
  } else if (type === 'postgresql') {
    port.value = 5432
  } else if (type === 'kafka') {
    port.value = 9092
  } else if (type === 'nsq') {
    port.value = 4150
  }
})

watch(
  () => props.initialValues,
  (next) => {
    if (!next) return
    dbType.value = next.dbType ?? 'mysql'
    name.value = next.name ?? ''
    esAddress.value = next.address ?? ''
    esNodes.value = next.addresses?.join('\n') ?? ''
    esConnectMode.value = next.addresses?.length ? 'multi' : next.address ? 'address' : 'host'
    host.value = next.host ?? ''
    const defaults: Partial<Record<DatabaseType, number>> = {
      mysql: 3306,
      postgresql: 5432,
      redis: 6379,
      elasticsearch: 9200,
      clickhouse: 9000,
      kafka: 9092,
      nsq: 4150,
    }
    port.value = next.port ?? defaults[next.dbType ?? 'mysql'] ?? 3306
    username.value = next.username ?? ''
    password.value = next.password ?? ''
    database.value = next.database ?? ''
    ssl.value = next.ssl ?? false
    redisDb.value = next.redisDb ?? 0
  }
)

const canSubmit = computed(() => {
  if (!name.value) return false
  if (dbType.value === 'elasticsearch' && esConnectMode.value === 'multi') {
    const nodes = esNodes.value.split('\n').map(s => s.trim()).filter(Boolean)
    if (nodes.length === 0) return false
  }
  if (dbType.value === 'elasticsearch' && esConnectMode.value === 'address') {
    if (!esAddress.value.trim()) return false
  } else if (!host.value) {
    return false
  }
  if (dbType.value === 'mysql') return !!username.value
  if (dbType.value === 'postgresql') return !!username.value
  if (dbType.value === 'clickhouse') return !!username.value
  if (dbType.value === 'elasticsearch') return esAuthMode.value === 'apikey' ? !!esApiKey.value : true
  return true
})

const canTest = computed(() => {
  if (dbType.value === 'elasticsearch' && esConnectMode.value === 'multi') {
    const nodes = esNodes.value.split('\n').map(s => s.trim()).filter(Boolean)
    if (nodes.length === 0) return false
  } else if (dbType.value === 'elasticsearch' && esConnectMode.value === 'address') {
    if (!esAddress.value.trim()) return false
  } else if (!host.value) {
    return false
  }
  if (dbType.value === 'mysql') return !!username.value
  if (dbType.value === 'postgresql') return !!username.value
  if (dbType.value === 'clickhouse') return !!username.value
  if (dbType.value === 'elasticsearch') return esAuthMode.value === 'apikey' ? !!esApiKey.value : true
  return true
})
const hostPlaceholder = computed(() => {
  if (dbType.value === 'kafka') return t('db.kafkaHostPlaceholder')
  if (dbType.value === 'nsq') return t('db.nsqHostPlaceholder')
  return t('asset.placeholderDb')
})
const databaseHint = computed(() =>
  dbType.value === 'postgresql' ? t('db.postgresDatabaseHint') : t('db.initialDbHint'))

function buildEsParams() {
  return {
    addresses: esConnectMode.value === 'multi'
      ? esNodes.value.split('\n').map(s => s.trim()).filter(Boolean)
      : undefined,
    address: esConnectMode.value === 'address' ? esAddress.value.trim() : undefined,
    host: host.value,
    port: port.value,
    username: esAuthMode.value === 'password' ? username.value : undefined,
    password: esAuthMode.value === 'password' ? password.value : undefined,
    useSSL: ssl.value,
    apiKey: esAuthMode.value === 'apikey' ? esApiKey.value : undefined
  }
}

async function onTestConnection() {
  if (!canTest.value) return
  testStatus.value = 'testing'
  testMessage.value = ''
  try {
    if (dbType.value === 'mysql') {
      const result = await dbService.mysqlTest({
        host: host.value,
        port: port.value,
        username: username.value,
        password: password.value,
        database: database.value || undefined,
        ssl: ssl.value
      })
      testStatus.value = result.ok ? 'success' : 'fail'
      testMessage.value = result.message
    } else if (dbType.value === 'redis') {
      const result = await dbService.redisTest({
        host: host.value,
        port: port.value,
        password: password.value || undefined,
        db: redisDb.value,
        ssl: ssl.value
      })
      testStatus.value = result.ok ? 'success' : 'fail'
      testMessage.value = result.message
    } else if (dbType.value === 'elasticsearch') {
      const result = await dbService.esTest(buildEsParams())
      testStatus.value = result.ok ? 'success' : 'fail'
      testMessage.value = result.message
    } else if (dbType.value === 'clickhouse') {
      const result = await dbService.clickhouseTest({
        host: host.value,
        port: port.value,
        username: username.value,
        password: password.value,
        database: database.value || undefined,
        ssl: ssl.value
      })
      testStatus.value = result.ok ? 'success' : 'fail'
      testMessage.value = result.message
    } else if (dbType.value === 'postgresql') {
      const result = await dbService.postgresTest({
        host: host.value,
        port: port.value,
        username: username.value,
        password: password.value,
        database: database.value || 'postgres',
        ssl: ssl.value,
      })
      testStatus.value = result.ok ? 'success' : 'fail'
      testMessage.value = result.message
    } else if (dbType.value === 'kafka' || dbType.value === 'nsq') {
      const result = await testBroker(dbType.value, {
        host: host.value,
        port: port.value,
        username: username.value || undefined,
        password: password.value || undefined,
        ssl: ssl.value,
      })
      testStatus.value = result.ok ? 'success' : 'fail'
      testMessage.value = result.message
    }
  } catch (err: unknown) {
    testStatus.value = 'fail'
    testMessage.value = err instanceof Error ? err.message : String(err)
  }
}

function onSubmit() {
  if (!canSubmit.value) return

  const dto: CreateAssetDto = {
    type: 'db',
    name: name.value,
    config: {
      dbType: dbType.value,
      addresses: dbType.value === 'elasticsearch' && esConnectMode.value === 'multi'
        ? esNodes.value.split('\n').map(s => s.trim()).filter(Boolean)
        : undefined,
      address: dbType.value === 'elasticsearch' && esConnectMode.value === 'address'
        ? esAddress.value.trim()
        : undefined,
      host: host.value,
      port: port.value,
      username: username.value,
      password: password.value,
      database: database.value || undefined,
      ssl: ssl.value,
      // Redis 才有意义;MySQL 时也保留字段(为 0),后端可忽略
      redisDb: dbType.value === 'redis' ? redisDb.value : undefined
    }
  }
  emit('submit', dto)
}

function onCancel() {
  emit('cancel')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    onSubmit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
  }
}
</script>

<template>
  <form class="db-form" @submit.prevent="onSubmit" @keydown="onKeydown">
    <!-- DB Type Switcher -->
    <div class="db-type-switcher">
      <div
        class="db-type-btn"
        :class="{ active: dbType === 'mysql' }"
        @click="dbType = 'mysql'"
      >
        <ProductIcon product="mysql" :size="17" />
        <span>MySQL</span>
      </div>
      <div
        class="db-type-btn"
        :class="{ active: dbType === 'postgresql' }"
        @click="dbType = 'postgresql'"
      >
        <ProductIcon product="postgresql" :size="17" />
        <span>PostgreSQL</span>
      </div>
      <div
        class="db-type-btn"
        :class="{ active: dbType === 'redis' }"
        @click="dbType = 'redis'"
      >
        <ProductIcon product="redis" :size="17" />
        <span>Redis</span>
      </div>
      <div
        class="db-type-btn"
        :class="{ active: dbType === 'elasticsearch' }"
        @click="dbType = 'elasticsearch'"
      >
        <ProductIcon product="elasticsearch" :size="17" />
        <span>Elasticsearch</span>
      </div>
      <div
        class="db-type-btn"
        :class="{ active: dbType === 'clickhouse' }"
        @click="dbType = 'clickhouse'"
      >
        <ProductIcon product="clickhouse" :size="17" />
        <span>ClickHouse</span>
      </div>
      <div
        class="db-type-btn"
        :class="{ active: dbType === 'kafka' }"
        @click="dbType = 'kafka'"
      >
        <ProductIcon product="kafka" :size="17" />
        <span>Kafka</span>
      </div>
      <div
        class="db-type-btn"
        :class="{ active: dbType === 'nsq' }"
        @click="dbType = 'nsq'"
      >
        <ProductIcon product="nsq" :size="17" />
        <span>NSQ</span>
      </div>
    </div>

    <div class="form-body">
      <!-- 左列: 连接信息 -->
      <div class="form-column">
        <div class="column-label">{{ t('asset.server') }}</div>

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
            autofocus
            required
          />
        </div>

        <div v-if="dbType === 'elasticsearch'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-connection</v-icon>
            Elasticsearch Endpoint
          </label>
          <div class="auth-mode-switch">
            <button
              type="button"
              class="auth-mode-btn"
              :class="{ active: esConnectMode === 'host' }"
              @click="esConnectMode = 'host'"
            >
              Host / Port
            </button>
            <button
              type="button"
              class="auth-mode-btn"
              :class="{ active: esConnectMode === 'address' }"
              @click="esConnectMode = 'address'"
            >
              Address URL
            </button>
            <button
              type="button"
              class="auth-mode-btn"
              :class="{ active: esConnectMode === 'multi' }"
              @click="esConnectMode = 'multi'"
            >
              Multi Nodes
            </button>
          </div>
        </div>

        <!-- Elasticsearch Multi Nodes -->
        <div v-if="dbType === 'elasticsearch' && esConnectMode === 'multi'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-server-network</v-icon>
            Node Addresses
            <span class="required">*</span>
          </label>
          <textarea
            v-model="esNodes"
            class="cyber-input"
            rows="3"
            placeholder="http://39.105.22.67:9201&#10;http://39.105.22.67:9202&#10;http://39.105.22.67:9203"
            required
          />
          <span class="field-hint">每行一个地址,支持轮询与故障转移</span>
        </div>

        <!-- Elasticsearch Address -->
        <div v-if="dbType === 'elasticsearch' && esConnectMode === 'address'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-link-variant</v-icon>
            Address
            <span class="required">*</span>
          </label>
          <input
            v-model="esAddress"
            type="text"
            class="cyber-input"
            placeholder="http://127.0.0.1:9200"
            required
          />
        </div>

        <!-- 主机:端口 -->
        <div v-if="dbType !== 'elasticsearch' || esConnectMode === 'host'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-server-network</v-icon>
            {{ t('asset.host') }} : {{ t('asset.port') }}
            <span class="required">*</span>
          </label>
          <div class="form-row host-port">
            <input
              v-model="host"
              type="text"
              class="cyber-input"
              :placeholder="hostPlaceholder"
              required
            />
            <input
              v-model.number="port"
              type="number"
              class="cyber-input mono"
              :placeholder="String(port)"
            />
          </div>
        </div>

        <!-- 用户名 (MySQL / ClickHouse) -->
        <div v-if="dbType === 'mysql' || dbType === 'postgresql' || dbType === 'clickhouse' || dbType === 'kafka'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-account-outline</v-icon>
            {{ t('asset.username') }}
            <span v-if="dbType !== 'kafka'" class="required">*</span>
          </label>
          <div class="input-group">
            <span class="input-prefix">@</span>
            <input
              v-model="username"
              type="text"
              class="cyber-input"
              :placeholder="t('db.usernamePlaceholder')"
              :required="dbType !== 'kafka'"
            />
          </div>
        </div>
      </div>

      <!-- 右列: 认证 -->
      <div class="form-column">
        <div class="column-label">{{ t('ssh.authMethod') }}</div>

        <!-- 密码 -->
        <div class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-lock-outline</v-icon>
            {{ t('asset.password') }}
            <span class="optional">{{ t('db.passwordOptional') }}</span>
          </label>
          <div class="input-group">
            <v-icon class="input-prefix" size="13">mdi-lock-outline</v-icon>
            <input
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              class="cyber-input"
              :placeholder="'••••••••'"
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

        <!-- 数据库 (MySQL / ClickHouse) -->
        <div v-if="dbType === 'mysql' || dbType === 'postgresql' || dbType === 'clickhouse'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-database-outline</v-icon>
            {{ t('asset.database') }}
            <span class="optional">{{ databaseHint }}</span>
          </label>
          <input
            v-model="database"
            type="text"
            class="cyber-input"
            :placeholder="t('asset.placeholderDatabase')"
          />
        </div>

        <!-- Redis DB 编号 -->
        <div v-if="dbType === 'redis'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-numeric</v-icon>
            Redis DB
          </label>
          <input
            v-model.number="redisDb"
            type="number"
            class="cyber-input mono"
            min="0"
            max="15"
            placeholder="0"
          />
        </div>

        <!-- Elasticsearch 认证方式 -->
        <div v-if="dbType === 'elasticsearch'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-shield-key-outline</v-icon>
            {{ t('db.authMode') }}
          </label>
          <div class="auth-mode-switch">
            <button
              type="button"
              class="auth-mode-btn"
              :class="{ active: esAuthMode === 'password' }"
              @click="esAuthMode = 'password'"
            >
              Basic Auth
            </button>
            <button
              type="button"
              class="auth-mode-btn"
              :class="{ active: esAuthMode === 'apikey' }"
              @click="esAuthMode = 'apikey'"
            >
              API Key
            </button>
          </div>
        </div>

        <!-- Elasticsearch 用户名 (Basic Auth) -->
        <div v-if="dbType === 'elasticsearch' && esAuthMode === 'password'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-account-outline</v-icon>
            {{ t('asset.username') }}
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

        <!-- Elasticsearch API Key -->
        <div v-if="dbType === 'elasticsearch' && esAuthMode === 'apikey'" class="form-field">
          <label class="field-label">
            <v-icon size="12">mdi-key-outline</v-icon>
            {{ t('db.apiKey') }}
          </label>
          <input
            v-model="esApiKey"
            type="password"
            class="cyber-input mono"
            placeholder="id:api_key"
          />
        </div>

        <!-- SSL -->
        <div class="form-field">
          <label class="field-label checkbox-label">
            <input v-model="ssl" type="checkbox" class="cyber-checkbox" />
            <v-icon size="12">mdi-lock-check-outline</v-icon>
            SSL/TLS
          </label>
        </div>
      </div>
    </div>

    <!-- 测试连接状态 -->
    <div v-if="testStatus !== 'idle'" class="test-status" :class="testStatus">
      <v-icon size="14">
        {{ testStatus === 'testing' ? 'mdi-loading mdi-spin' : testStatus === 'success' ? 'mdi-check-circle' : 'mdi-alert-circle' }}
      </v-icon>
      <span>{{ testMessage }}</span>
    </div>

    <!-- Footer -->
    <div class="form-footer">
      <div class="footer-left">
        <button
          type="button"
          class="cyber-btn-test"
          :disabled="!canTest || testStatus === 'testing'"
          :class="{ testing: testStatus === 'testing' }"
          @click="onTestConnection"
        >
          <v-icon size="14">
            {{ testStatus === 'testing' ? 'mdi-loading mdi-spin' : 'mdi-connection' }}
          </v-icon>
          {{ testStatus === 'testing' ? t('ssh.testing') : t('ssh.testConnection') }}
        </button>
      </div>
      <div class="footer-right">
        <div class="shortcut-hint">
          <kbd>{{ modKey }}</kbd>+<kbd>Enter</kbd> {{ t('common.save') }} · <kbd>Esc</kbd> {{ t('common.cancel') }}
        </div>
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
    </div>
  </form>
</template>

<style scoped>
.db-form {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.host-port .cyber-input {
  padding: 5px 8px;
  font-size: 12px;
  height: 30px;
  min-height: auto;
}

.db-type-switcher {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.db-type-btn {
  flex: 1 1 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid var(--line-2);
  background: var(--bg-input);
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  font-size: 13px;
  font-weight: 500;
}

.db-type-btn:hover:not(.active) {
  border-color: var(--focus-cyan);
  background: var(--hover-cyan-soft);
}

.db-type-btn.active {
  border-color: var(--cyan);
  background: var(--active-cyan);
  color: var(--cyan);
  box-shadow: var(--glow-soft);
}

.form-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 520px) {
  .form-body {
    grid-template-columns: 1fr;
  }
}

.form-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.column-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 6px;
}

.column-label::after {
  content: "";
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--line-2), transparent);
}

.form-field {
  display: flex;
  flex-direction: column;
}

.input-suffix-btn {
  position: absolute;
  right: 6px;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s;
}

.input-suffix-btn:hover {
  color: var(--cyan);
  background: var(--hover-cyan);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
}

.cyber-checkbox {
  width: 14px;
  height: 14px;
  accent-color: var(--purple);
}

.test-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  margin-top: 4px;
  animation: fadeIn 0.2s ease;
}

.test-status.testing {
  background: var(--hover-cyan-soft);
  border: 1px solid var(--status-connecting-border);
  color: var(--cyan);
}

.test-status.success {
  background: var(--status-online-bg);
  border: 1px solid var(--status-online-border);
  color: var(--green);
}

.test-status.fail {
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  color: var(--red);
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 16px;
  margin-top: 20px;
  border-top: 1px solid var(--line);
}

.footer-left {
  display: flex;
  align-items: center;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shortcut-hint {
  font-size: 10px;
  color: var(--muted);
  margin-right: 8px;
  white-space: nowrap;
}

.shortcut-hint kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 5px;
  background: var(--kbd-bg);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--cyan);
}

.cyber-btn-test {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--cyan);
  background: var(--hover-cyan-soft);
  border: 1px solid var(--status-connecting-border);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.cyber-btn-test:hover:not(:disabled) {
  background: var(--active-cyan);
  border-color: var(--cyan);
  box-shadow: var(--glow-soft);
}

.cyber-btn-test:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cyber-btn-test.testing {
  color: var(--cyan);
  border-color: var(--status-connecting-border);
  animation: testPulse 1.5s infinite;
}

@keyframes testPulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--focus-cyan); }
  50% { box-shadow: 0 0 0 6px transparent; }
}

:deep(.mdi-spin) {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.auth-mode-switch {
  display: flex;
  gap: 6px;
}

.auth-mode-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: var(--bg-input);
  color: var(--text-2);
  cursor: pointer;
  font-size: 11px;
  font-family: inherit;
  transition: all 0.2s;
}

.auth-mode-btn.active {
  border-color: var(--cyan);
  background: var(--active-cyan);
  color: var(--cyan);
}

.auth-mode-btn:hover:not(.active) {
  border-color: var(--focus-cyan);
}
</style>
