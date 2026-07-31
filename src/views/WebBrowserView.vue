<script setup lang="ts">
/**
 * 网页浏览子页面(Web Access)
 *
 * 从 SSH 终端工具栏打开:地址栏输入远端内网地址,通过 SSH 端口转发
 * (ssh_add_web_proxy_forward,自动改写 HTTP Host 头,修复虚拟主机 404)
 * 在本窗口内嵌的 Tauri 子 webview 中打开,体验等同内嵌浏览器。
 *
 * 生命周期:
 *  - keep-alive 切换 tab:onDeactivated 隐藏子 webview,onActivated 恢复并重新对齐 bounds
 *  - tab 关闭(真正 unmount):关闭子 webview
 *  - 窗口 resize / 布局变化:ResizeObserver + window resize 重新 setPosition/setSize
 *
 * 纯浏览器 dev(无 Tauri IPC)降级为提示页,不崩。
 */
import { ref, computed, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'
import { useNotifyStore } from '@/stores/notify'
import { sshAddLocalForward, sshAddWebProxyForward } from '@/services/ssh'
import { logAudit } from '@/services/audit'
import { parseInstanceId } from '@/utils/tabId'
import type { Webview } from '@tauri-apps/api/webview'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const assetStore = useAssetStore()
const notify = useNotifyStore()

const props = defineProps<{
  /** Tab instance id(路由 web/:id 传入) */
  id: string
}>()

/** 关联的 SSH 会话 id:优先路由 query(拖出独立窗口也能带上),兜底 tab 的 assetId */
const sessionId = computed(() => {
  const q = route.query.session
  if (typeof q === 'string' && q) return q
  return appStore.tabs.find(tab => tab.id === props.id)?.assetId ?? ''
})

/** 关联 SSH 会话对应的资产(审计埋点用) */
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

/** 解析地址栏输入:自动补 http:// 前缀,返回 URL 与是否 https */
function parseTarget(input: string): { url: URL; isHttps: boolean } | null {
  let raw = input.trim()
  if (!raw) return null
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) raw = 'http://' + raw
  try {
    const url = new URL(raw)
    if (!url.hostname) return null
    return { url, isHttps: url.protocol === 'https:' }
  } catch {
    return null
  }
}

async function closeChildWebview() {
  const wv = childWebview
  childWebview = null
  if (wv) {
    try { await wv.close() } catch { /* 已关闭 */ }
  }
}

/** 把子 webview 的 bounds 精确对齐到占位 div(视口逻辑像素) */
async function syncBounds() {
  if (!childWebview || !hostRef.value) return
  const rect = hostRef.value.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return
  try {
    const { LogicalPosition, LogicalSize } = await import('@tauri-apps/api/dpi')
    await childWebview.setPosition(new LogicalPosition(Math.round(rect.left), Math.round(rect.top)))
    await childWebview.setSize(new LogicalSize(Math.round(rect.width), Math.round(rect.height)))
  } catch {
    // webview 可能刚被关闭,静默
  }
}

/** 创建子 webview 覆盖占位区;重复访问新 URL 时先关旧的再重建(无 navigate API,重建简单可靠) */
async function spawnWebview(targetUrl: string) {
  await closeChildWebview()
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const { Webview } = await import('@tauri-apps/api/webview')
  const rect = hostRef.value?.getBoundingClientRect()
  webviewSeq += 1
  // label 只允许 a-zA-Z0-9-/:_,且每次换新避免与未完全销毁的旧实例冲突
  const label = `web-${props.id}-${webviewSeq}`.replace(/[^a-zA-Z0-9\-/:_]/g, '-')
  const wv = new Webview(getCurrentWindow(), label, {
    url: targetUrl,
    x: Math.round(rect?.left ?? 0),
    y: Math.round(rect?.top ?? 0),
    width: Math.max(Math.round(rect?.width ?? 800), 100),
    height: Math.max(Math.round(rect?.height ?? 600), 100),
  })
  void wv.once('tauri://error', (error) => {
    console.error('[web-browser] create webview failed:', error)
    errorText.value = t('web.browser.webviewFailed')
  })
  childWebview = wv
}

async function navigate() {
  if (loading.value) return
  const target = parseTarget(urlInput.value)
  if (!target) {
    notify.notify({
      message: t(urlInput.value.trim() ? 'web.browser.invalidUrl' : 'web.browser.emptyUrl'),
      color: 'error',
      timeout: 4000,
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

  const { url, isHttps } = target
  const remoteHost = url.hostname
  const remotePort = parseInt(url.port, 10) || (isHttps ? 443 : 80)
  const pathQuery = url.pathname + url.search + url.hash
  if (isHttps) {
    // TLS 密文无法明文改写 Host 头,降级为裸透传直连(可能因证书不受信失败)
    notify.notify({ message: t('web.browser.httpsUnsupported'), color: 'warning', timeout: 5000 })
  }

  loading.value = true
  errorText.value = ''
  try {
    const localPort = isHttps
      ? await sshAddLocalForward(sessionId.value, 0, remoteHost, remotePort)
      : await sshAddWebProxyForward(sessionId.value, 0, remoteHost, remotePort)
    const targetUrl = `${isHttps ? 'https' : 'http'}://127.0.0.1:${localPort}${pathQuery}`
    await spawnWebview(targetUrl)
    loadedUrl.value = url.href
    logAudit({
      category: 'ssh', action: 'web_access', target: url.href,
      detail: { localPort, remoteHost, remotePort },
      sessionId: sessionId.value, assetId: asset.value?.id, success: true,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    errorText.value = msg
    notify.notify({ message: `${t('web.browser.forwardFailed')}: ${msg}`, color: 'error', timeout: 5000 })
    logAudit({
      category: 'ssh', action: 'web_access', target: url.href,
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

function onWindowResize() {
  void syncBounds()
}

onMounted(() => {
  if (hostRef.value) {
    // 侧栏折叠 / 右面板开合 / 窗口分栏都会改变占位 div 尺寸,ResizeObserver 全覆盖
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
})

// keep-alive 切走:子 webview 是原生层,不随主 webview 隐藏,必须手动 hide
onDeactivated(() => {
  if (childWebview) {
    childWebview.hide().catch(() => {})
  }
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
