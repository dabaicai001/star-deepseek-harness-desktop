<script setup lang="ts">
/**
 * 服务器网页访问(Web Gateway)
 *
 * 前端 iframe 加载本地 HTTP 网关;网关解析目标后经 SSH direct-tcpip 通道
 * 从服务器侧出口发起 HTTP/HTTPS 请求(等同服务器网络视角,可达内网与服务器
 * localhost 服务)。HTTPS 在网关 rustls 层端到端终止,前端只见本地明文 HTTP。
 */
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import { useNotifyStore } from '@/stores/notify'
import { sshStartWebGateway, sshStopWebGateway, sshWebGatewayPort, openExternalUrl } from '@/services/ssh'
import { logAudit } from '@/services/audit'
import { parseInstanceId, generateInstanceId } from '@/utils/tabId'
import ContextMenu from '@/components/common/ContextMenu.vue'
import type { MenuItem } from '@/components/common/ContextMenu.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
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
const iframeRef = ref<HTMLIFrameElement | null>(null)
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

/** 确保网关存活:缓存端口可能已失效(SSH 重连后 disconnect 会停掉网关、
 * 其他同会话标签页关闭时也会停掉共享网关),先以后端真实状态校验,不一致则重启。 */
async function ensureGateway(): Promise<number> {
  if (gatewayPort) {
    const alive = await sshWebGatewayPort(sessionId.value).catch(() => null)
    if (alive !== gatewayPort) gatewayPort = 0
  }
  if (!gatewayPort) {
    gatewayPort = await sshStartWebGateway(sessionId.value)
  }
  return gatewayPort
}

/** 由原始 URL 构造网关代理 URL(网关未启动时返回 null) */
function proxyUrlOf(original: string): string | null {
  const target = normalize(original)
  if (!target || !gatewayPort) return null
  return `http://127.0.0.1:${gatewayPort}/__proxy__/${target.scheme}/${target.hostport}${target.pathQuery}`
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
    await ensureGateway()
    const proxyUrl = proxyUrlOf(target.href)
    // 使用 iframe 渲染(内嵌,不需要创建额外 Webview 窗口)
    if (proxyUrl && iframeRef.value) {
      iframeRef.value.src = proxyUrl
    }
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

function onIframeError() {
  errorText.value = t('web.browser.forwardFailed')
}

// ── iframe 通信(桌面应用源 tauri.localhost 与网关源 127.0.0.1:port 跨源,
// 外层碰不到 iframe document;网关在改写 HTML 时注入桥接脚本,页面内部完成
// 点击拦截/右键/导航上报,统一 postMessage 与本视图通信) ──

const ctxMenu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

/** 把 /__proxy__/{scheme}/{hostport}/path 形式的网关 URL 还原为原始 URL */
function proxyToOriginal(url: URL): string | null {
  const prefix = '/__proxy__/'
  if (!url.pathname.startsWith(prefix)) return null
  const rest = url.pathname.slice(prefix.length)
  const parts = rest.split('/')
  if (parts.length < 2) return null
  const scheme = parts[0]
  const hostport = parts[1]
  if (!scheme || !hostport) return null
  const path = '/' + parts.slice(2).join('/')
  return `${scheme}://${hostport}${path}${url.search}${url.hash}`
}

/** 当前页面原始 URL:由桥接脚本的 navigated 消息维护,跨源安全 */
function currentOriginalUrl(): string {
  return loadedUrl.value
}

/** 在新 StarHub web 标签页打开链接(对应页面里 target=_blank 的链接):
 * sandbox iframe 内 _blank 弹窗会被 webview 吞掉,点击无反应;
 * 改为按项目 tab 模式新开一个 WebBrowserView 并自动导航。 */
function openLinkInNewTab(originalUrl: string) {
  const instanceId = generateInstanceId(`web-${sessionId.value}`)
  let host = originalUrl
  try { host = new URL(originalUrl).hostname || originalUrl } catch { /* noop */ }
  const title = `${t('web.browser.newTabTitle')} · ${host}`
  appStore.addTab({ id: instanceId, assetId: sessionId.value, title, type: 'web' })
  router.push({
    name: 'web-browser',
    params: { id: instanceId },
    query: { session: sessionId.value, url: originalUrl },
  })
}

/** 向 iframe 内的桥接脚本发命令(back/forward/reload) */
function sendCmd(type: string) {
  if (!gatewayPort) return
  try {
    iframeRef.value?.contentWindow?.postMessage({ __starhub: 1, type }, `http://127.0.0.1:${gatewayPort}`)
  } catch { /* noop */ }
}

/** 桥接脚本上报:导航(地址栏/tab 标题同步)、_blank 新开 tab、右键菜单 */
function onGatewayMessage(e: MessageEvent) {
  const d = e.data as { __starhub?: number; type?: string; href?: string; url?: string; title?: string; x?: number; y?: number } | null
  if (!d || d.__starhub !== 1) return
  if (gatewayPort && e.origin !== `http://127.0.0.1:${gatewayPort}`) return
  if (d.type === 'navigated' && d.href) {
    // 切 tab 恢复期间,只接受恢复目标的上报,忽略初始 src 竞态产生的旧地址
    if (restoring) {
      if (d.href !== restoring) return
      restoring = null
    }
    try {
      const original = proxyToOriginal(new URL(d.href))
      if (original) {
        loadedUrl.value = original
        urlInput.value = original
      }
    } catch { /* noop */ }
    if (d.title) {
      appStore.updateTabTitle(props.id, `${t('web.browser.newTabTitle')} · ${d.title}`)
    }
  } else if (d.type === 'open-in-new-tab' && d.url) {
    try {
      const original = proxyToOriginal(new URL(d.url))
      if (original) openLinkInNewTab(original)
    } catch { /* noop */ }
  } else if (d.type === 'contextmenu') {
    const rect = iframeRef.value?.getBoundingClientRect()
    if (!rect) return
    ctxMenu.value = {
      x: rect.left + (d.x ?? 0),
      y: rect.top + (d.y ?? 0),
      items: buildIframeMenuItems(),
    }
  }
}

function buildIframeMenuItems(): MenuItem[] {
  return [
    {
      type: 'item', icon: 'mdi-arrow-left', label: t('web.browser.menuBack'),
      onClick: () => sendCmd('cmd-back'),
    },
    {
      type: 'item', icon: 'mdi-arrow-right', label: t('web.browser.menuForward'),
      onClick: () => sendCmd('cmd-forward'),
    },
    {
      type: 'item', icon: 'mdi-refresh', label: t('web.browser.menuReload'),
      onClick: () => sendCmd('cmd-reload'),
    },
    { type: 'divider' },
    {
      type: 'item', icon: 'mdi-content-copy', label: t('web.browser.menuCopyAddress'),
      onClick: () => {
        const url = currentOriginalUrl()
        if (!url) return
        navigator.clipboard.writeText(url)
          .then(() => notify.notify({ message: t('web.browser.copySuccess'), color: 'success', timeout: 2000 }))
          .catch(() => {})
      },
    },
    {
      type: 'item', icon: 'mdi-open-in-new', label: t('web.browser.menuOpenExternal'),
      onClick: () => {
        const url = currentOriginalUrl()
        if (!url) return
        openExternalUrl(url).catch(e => {
          const msg = e instanceof Error ? e.message : String(e)
          notify.notify({ message: msg, color: 'error', timeout: 4000 })
        })
      },
    },
  ]
}

function goBack() {
  sendCmd('cmd-back')
}

function goForward() {
  sendCmd('cmd-forward')
}

// ── keep-alive 状态恢复:切 tab 失活时 iframe 被移入离屏容器,浏览器对
// 重新挂载的 iframe 会按 src 属性重新导航(回退到首次设置的初始地址),
// 激活时按当前真实地址重新加载,保住浏览位置(URL 级状态)。 ──
let iframeEvicted = false
/** 恢复导航的目标代理 URL:竞态期间忽略其他 navigated 上报 */
let restoring: string | null = null

onDeactivated(() => {
  iframeEvicted = true
})

onActivated(() => {
  if (!iframeEvicted) return
  iframeEvicted = false
  if (!loadedUrl.value) return
  void (async () => {
    try {
      await ensureGateway()
      const url = proxyUrlOf(loadedUrl.value)
      if (url && iframeRef.value) {
        restoring = url
        iframeRef.value.src = url
        // 兜底:恢复失败(网关异常等)时解除 navigated 屏蔽
        setTimeout(() => { restoring = null }, 8000)
      }
    } catch { /* 网关不可达时用户可手动刷新 */ }
  })()
})

onMounted(() => {
  window.addEventListener('resize', () => { /* iframe 自适应 */ })
  window.addEventListener('message', onGatewayMessage)
  // 从其他标签页带 URL 跳转过来(_blank 新开 tab)时自动导航
  const initial = route.query.url
  if (typeof initial === 'string' && initial) {
    urlInput.value = initial
    void nextTick(() => navigate())
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', () => {})
  window.removeEventListener('message', onGatewayMessage)
  if (gatewayPort && sessionId.value) {
    sshStopWebGateway(sessionId.value).catch(() => {})
    gatewayPort = 0
  }
})
</script>

<template>
  <div class="web-browser-view">
    <div class="wb-toolbar">
      <v-icon size="14" class="wb-toolbar-icon">mdi-web</v-icon>
      <button
        class="action-btn"
        :title="t('web.browser.menuBack')"
        :aria-label="t('web.browser.menuBack')"
        :disabled="!loadedUrl"
        @click="goBack"
      >
        <v-icon size="14">mdi-arrow-left</v-icon>
      </button>
      <button
        class="action-btn"
        :title="t('web.browser.menuForward')"
        :aria-label="t('web.browser.menuForward')"
        :disabled="!loadedUrl"
        @click="goForward"
      >
        <v-icon size="14">mdi-arrow-right</v-icon>
      </button>
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
      <iframe
        v-show="loadedUrl && !errorText"
        ref="iframeRef"
        class="wb-iframe"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        @error="onIframeError"
      />
      <ContextMenu
        v-if="ctxMenu"
        :x="ctxMenu.x"
        :y="ctxMenu.y"
        :items="ctxMenu.items"
        @close="ctxMenu = null"
      />
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

.wb-iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
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
  z-index: 1;
}

.wb-status-error {
  color: var(--red);
}
</style>
