<script setup lang="ts">
/**
 * 服务器网页访问(Web Gateway)
 *
 * 通过 SSH 会话在服务器侧发起 HTTP/HTTPS 请求,经本地网关 HTTP 代理回传,
 * 前端 webview 以纯 HTTP 方式渲染,HTTPS 在 Rust TLS 层终止,无证书问题。
 * 方案:全流量经 SSH direct-tcpip 通道中转(等同服务器网络视角)。
 */
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import { useNotifyStore } from '@/stores/notify'
import { sshStartWebGateway, sshStopWebGateway } from '@/services/ssh'
import { logAudit } from '@/services/audit'
import { parseInstanceId } from '@/utils/tabId'
import type { Webview } from '@tauri-apps/api/webview'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const assetStore = useAssetStore()
const notify = useNotifyStore()

const props = defineProps<{
  id: string
}>()

const sessionId = computed(() => {
  const q = route.query.session
  if (typeof q === 'string' && q) return q
  return appStore.tabs.find(tab => tab.id === props.id)?.assetId ?? ''
})

const asset = computed(() =>
  assetStore.assets.find(a => a.id === parseInstanceId(sessionId.value).assetId)
)

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const urlInput = ref('')
const loading = ref(false)
const loadedUrl = ref('')
const errorText = ref('')

const hostRef = ref<HTMLElement | null>(null)
let childWebview: Webview | null = null
let webviewSeq = 0
let resizeObserver: ResizeObserver | null = null

/** 网关监听端口:由 sshStartWebGateway 返回,同一个 sessionId 幂等 */
let gatewayPort = 0

/** 规范化 URL:自动补 https://,确保有有效 hostname */
function normalize(input: string): { scheme: string; hostport: string; pathQuery: string; href: string } | null {
  let raw = input.trim()
  if (!raw) return null
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) raw = 'https://' + raw
  let url: URL
  try { url = new URL(raw) } catch { return null }
  if (!url.hostname) return null
  const scheme = url.protocol.replace(':', '')
  let hostport = url.hostname
  const port = parseInt(url.port, 10) || (scheme === 'https' ? 443 : 80)
  const defaultPort = scheme === 'https' ? 443 : 80
  if (port !== defaultPort) hostport += `:${port}`
  const pathQuery = url.pathname + url.search + url.hash
  return { scheme, hostport, pathQuery: pathQuery || '/', href: url.href }
}

async function closeChildWebview() {
  const wv = childWebview
  childWebview = null
  if (wv) {
    try { await wv.close() } catch { /* 已关闭 */ }
  }
}

async function syncBounds() {
  if (!childWebview || !hostRef.value) return
  const rect = hostRef.value.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return
  try {
    const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi')
    await childWebview.setPosition(new LogicalPosition(Math.round(rect.left), Math.round(rect.top)))
    await childWebview.setSize(new LogicalSize(Math.round(rect.width), Math.round(rect.height)))
  } catch { /* 静默 */ }
}

async function spawnWebview(targetUrl: string) {
  await closeChildWebview()
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const { Webview } = await import('@tauri-apps/api/webview')
  const rect = hostRef.value?.getBoundingClientRect()
  webviewSeq += 1
  const label = `web-${props.id}-${webviewSeq}`.replace(/[^a-zA-Z0-9\-/:_]/g, '-')
  const wv = new Webview(getCurrentWindow(), label, {
    url: targetUrl,
    x: Math.round(rect?.left ?? 0),
    y: Math.round(rect?.top ?? 0),
    width: Math.max(Math.round(rect?.width ?? 800), 100),
    height: Math.max(Math.round(rect?.height ?? 600), 100),
  })
  void wv.once('tauri://error', (error) => {
    console.error('[web-gateway] create webview failed:', error)
    errorText.value = t('web.browser.webviewFailed')
  })
  childWebview = wv
}

async function navigate() {
  if (loading.value) return
  const target = normalize(urlInput.value)
  if (!target) {
    notify.notify({
      message: t(urlInput.value.trim() ? 'web.browser.invalidUrl' : 'web.browser.emptyUrl'),
      color: 'error', timeout: 4000,
    })
    return
  }
  if (!isTauri) {
    notify.notify({ message: t('web.browser.tauriRequired'), color: 'error', timeout: 4000 })
    return
  }
  if (!sessionId.value) {
    notify.notify({ message: t('web.browser.noSession'), color: 'error', timeout: 4000 })
    return
  }

  loading.value = true
  errorText.value = ''
  try {
    if (!gatewayPort) {
      gatewayPort = await sshStartWebGateway(sessionId.value)
    }
    const proxyUrl = `http://127.0.0.1:${gatewayPort}/__proxy__/${target.scheme}/${target.hostport}${target.pathQuery}`
    await spawnWebview(proxyUrl)
    loadedUrl.value = target.href
    logAudit({
      category: 'ssh', action: 'web_access', target: target.href,
      detail: { gatewayPort, scheme: target.scheme, hostport: target.hostport },
      sessionId: sessionId.value, assetId: asset.value?.id, success: true,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errorText.value = msg
    notify.notify({ message: `${t('web.browser.forwardFailed')}: ${msg}`, color: 'error', timeout: 5000 })
    logAudit({
      category: 'ssh', action: 'web_access', target: target.href,
      sessionId: sessionId.value, assetId: asset.value?.id, success: false,
    })
  } finally {
    loading.value = false
  }
}

function reload() {
  if (!loadedUrl.value) return
  urlInput.value = loadedUrl.value
  void navigate()
}

function onWindowResize() { void syncBounds() }

onMounted(() => {
  if (hostRef.value) {
    resizeObserver = new ResizeObserver(() => { void syncBounds() })
    resizeObserver.observe(hostRef.value)
  }
  window.addEventListener('resize', onWindowResize)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', onWindowResize)
  void closeChildWebview()
  if (gatewayPort && sessionId.value) {
    sshStopWebGateway(sessionId.value).catch(() => {})
    gatewayPort = 0
  }
})

onDeactivated(() => {
  if (childWebview) childWebview.hide().catch(() => {})
})

onActivated(() => {
  if (childWebview) {
    childWebview.show().catch(() => {})
    void nextTick(() => { void syncBounds() })
  }
})
</script>

<template>
  <div class="web-browser-view">
    <div class="wb-toolbar">
      <v-icon size="14" class="wb-toolbar-icon">mdi-web</v-icon>
      <input
        v-model="urlInput"
        class="cyber-input wb-address"
        :placeholder="t('web.browser.addressPlaceholder')"
        spellcheck="false"
        @keydown.enter="navigate"
      />
      <button class="cyber-btn cyber-btn-sm wb-go" :disabled="loading" @click="navigate">
        <v-icon size="13">mdi-arrow-right</v-icon>
        {{ t('web.browser.go') }}
      </button>
      <button
        class="action-btn"
        :title="t('web.browser.reload')"
        :aria-label="t('web.browser.reload')"
        :disabled="!loadedUrl || loading"
        @click="reload"
      >
        <v-icon size="14">mdi-refresh</v-icon>
      </button>
    </div>

    <div ref="hostRef" class="wb-host">
      <div v-if="!isTauri" class="wb-overlay">
        <v-icon size="28">mdi-monitor-off</v-icon>
        <p>{{ t('web.browser.tauriRequired') }}</p>
      </div>
      <div v-else-if="!loadedUrl" class="wb-overlay">
        <v-icon size="28">mdi-earth</v-icon>
        <p>{{ t('web.browser.hint') }}</p>
      </div>
      <div v-if="loading" class="wb-status">{{ t('web.browser.loading') }}</div>
      <div v-if="errorText" class="wb-status wb-status-error">{{ errorText }}</div>
    </div>
  </div>
</template>

<style scoped>
.web-browser-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.wb-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line-2);
  background: var(--panel);
  flex-shrink: 0;
}

.wb-toolbar-icon {
  color: var(--cyan);
  flex-shrink: 0;
}

.wb-address {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 6px 12px;
}

.wb-go {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.wb-host {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--bg-2);
}

.wb-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
  padding: 0 24px;
}

.wb-status {
  position: absolute;
  left: 12px;
  bottom: 10px;
  font-size: 11px;
  color: var(--text-2);
}

.wb-status-error {
  color: var(--red);
}
</style>
