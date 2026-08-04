<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, cloneVNode, defineComponent, type Component, type VNode } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter, useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useAppStore, SIDEBAR_COLLAPSED_WIDTH, type Tab } from '@/stores/app'
import { useThemeStore } from '@/stores/theme'
import { useDialogStore } from '@/stores/dialog'
import { useAiStore, type AiAgent } from '@/stores/ai'
import { useTransferStore } from '@/stores/transfer'
import { useBreakpoint } from '@/composables/useBreakpoint'
import NewConnectionDialog from '@/components/common/NewConnectionDialog.vue'
import AssetTree from '@/components/asset/AssetTree.vue'
import SidebarHandle from '@/components/layout/SidebarHandle.vue'
import CommandPalette from '@/components/layout/CommandPalette.vue'
import NotificationCenter from '@/components/layout/NotificationCenter.vue'
import SettingsView from '@/views/SettingsView.vue'
import TransferDock from '@/components/transfer/TransferDock.vue'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import * as tauriWindowApi from '@tauri-apps/api/window'
import { WebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow'
import { emitTo, listen as tauriListen } from '@tauri-apps/api/event'
import {
  getDetachedInfo,
  detachedLabelFor,
  buildDetachedUrl,
  TAB_REATTACH_EVENT,
  LOCAL_TAB_DETACH_EVENT,
} from '@/lib/windowDetach'
import { generateInstanceId } from '@/utils/tabId'
import { routeNameForAsset, openAssetTab as openAssetTabRouting } from '@/utils/assetRouting'
import { version as appVersion } from '~package.json'
import logoUrl from '@/assets/logo-star.png'
import type { Asset } from '@/types/asset'
import type { CreateAssetDto } from '@/types/asset'

const { t, locale } = useI18n()
const router = useRouter()
const route = useRoute()
// Vite 开发态允许 `?mock=1` 直接挂载目标路由,无需先创建持久化资产/tab。
// 仅用于真实布局下的视觉与性能回归,生产构建恒为 false。
const devMockWorkspace = computed(() => import.meta.env.DEV && route.query.mock === '1')
const assetStore = useAssetStore()
const appStore = useAppStore()
const themeStore = useThemeStore()
const dlg = useDialogStore()
const aiStore = useAiStore()
const transferStore = useTransferStore()
const bp = useBreakpoint()
aiStore.ensureAgentsShape()

// P1 §A:欢迎页装饰层在 < 1280px 窗口下整体关闭(只剩栅格遮罩),
// 极光 + 漂浮粒子 GPU 渲染开销大,小窗口视觉抢戏
const showWelcomeDecor = computed(() => bp.width.value >= 1280)

const showNewConnection = ref(false)
const showSettings = ref(false)
type SettingsTabKey = 'general' | 'appearance' | 'ai' | 'about'
const settingsInitialTab = ref<SettingsTabKey>('general')

function openSettings(tab: SettingsTabKey = 'general') {
  settingsInitialTab.value = tab
  showSettings.value = true
}
// 从顶栏菜单"快速新建"入口传入,弹 dialog 时直接跳过 type 选择
const newConnectionInitialType = ref<'ssh' | 'db' | 'docker' | 'excel' | undefined>(undefined)

// dialog 关闭时清掉 initialType,下次开 + 按钮回到正常 type 选择页
import { watch as vueWatch2 } from 'vue'
vueWatch2(showNewConnection, (open) => {
  if (!open) newConnectionInitialType.value = undefined
})

// 跨平台快捷键修饰键(Mac ⌘, Win/Linux Ctrl)
const isMac = ref(false)
const isLinux = ref(false)
const modKey = computed(() => isMac.value ? '⌘' : 'Ctrl')

// 快捷键:⌘+B / Ctrl+B 折叠/展开 sidebar
// 快捷键:⌘+Shift+B / Ctrl+Shift+B 折叠/展开右侧面板
function onKeydown(e: KeyboardEvent) {
  if (isEditableEventTarget(e.target)) return
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault()
    if (e.shiftKey) {
      appStore.toggleRightPanel()
    } else {
      appStore.toggleSidebar()
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
    e.preventDefault()
    focusAiQuickChat()
  } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault()
    closeFloatingSurfaces()
    openSettings()
  } else if (e.key === 'Escape') {
    closeFloatingSurfaces()
  }
}

function focusAiQuickChat() {
  if (!aiStore.isAiConfigured()) {
    openSettings('ai')
    return
  }
  const agent = aiStore.agents[0]
  if (!agent) return
  // 如果已有 AI tab,直接切过去;否则新建
  const existingAiTab = appStore.tabs.find(tab => tab.type === 'ai')
  if (existingAiTab) {
    appStore.setActiveTab(existingAiTab.id)
    router.push({ name: 'ai', params: { id: existingAiTab.id } })
  } else {
    openAiAgentTab(agent, true)
  }
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function closeFloatingSurfaces() {
  userMenuOpen.value = false
  closeNewTabPicker()
  closeTabBarContextMenu()
  closeTabContextMenu()
  closeAssetPicker()
  closeWorkspaceContextMenu()
}

// ====== 窗口控件(Tauri window API) ======
let appWindow: ReturnType<typeof tauriWindowApi.getCurrentWindow> | null = null
try {
  appWindow = tauriWindowApi.getCurrentWindow()
} catch {
  // 纯浏览器 dev / 预览环境没有 Tauri window 元数据,窗口按钮静默降级。
}
const isMaximized = ref(false)

async function refreshMaximized() {
  if (!appWindow) return
  try {
    isMaximized.value = await appWindow.isMaximized()
  } catch {
    // 非 Tauri 环境(纯 web dev)下会失败,静默
  }
}

async function winMinimize() {
  if (!appWindow) return
  try { await appWindow.minimize() } catch {}
}

async function winToggleMaximize() {
  if (!appWindow) return
  try {
    if (await appWindow.isMaximized()) {
      await appWindow.unmaximize()
    } else {
      await appWindow.toggleMaximize()
    }
    await refreshMaximized()
  } catch {}
}

async function winClose() {
  if (!appWindow) return
  try { await appWindow.close() } catch {}
}

function onTitlebarDblclick() {
  winToggleMaximize()
}

// ====== Linux/Wayland 窗口拖拽兜底 ======
// data-tauri-drag-region 在某些 Wayland 合成器(如旧版 Mutter)上不生效,
// 在 Linux 上额外监听 mousedown 主动调用 startDragging() 作为兜底。
// 排除所有交互元素(button/input/a 等),仅对标题栏空白区域生效。
function onTitlebarMousedown(e: MouseEvent) {
  if (!isLinux.value) return
  if (e.button !== 0) return
  if (!appWindow) return
  const target = e.target as HTMLElement
  // 排除交互元素及其子元素
  if (target.closest(
    'button, input, textarea, select, a, [role="button"], ' +
    '.window-controls, .top-actions, .logo, .user-menu, .tab-strip-wrap, .tab'
  )) return
  e.preventDefault()
  appWindow.startDragging().catch(() => {})
}

// ====== 标签页拖出为独立窗口 ======
// detachedInfo 非空 = 当前窗口就是被拖出的独立工作区窗口(渲染精简外壳)
const detachedInfo = getDetachedInfo()

/**
 * 拖出手势状态:dragging = 已超过位移阈值进入拖拽;detachArmed = 已离开 tab 条死区,松开即拖出。
 *
 * 注意:不能用 HTML5 drag-and-drop —— Windows 上 tauri.conf.json 的
 * `dragDropEnabled: true`(SFTP / Excel 拖文件进窗依赖系统级拖放)会拦截 HTML5 DnD,
 * 导致 tab 拖拽完全失效(Tauri 官方文档明确说明,仅 Windows 受影响)。
 * 因此这里用 Pointer Events + setPointerCapture 自实现拖拽手势,与系统拖放互不干扰。
 */
const tabDragState = ref<{ tabId: string; clientX: number; clientY: number; dragging: boolean; detachArmed: boolean } | null>(null)

/** 按下时的拖拽上下文(未过阈值前仅记录,不影响点击) */
let tabPointerDrag: { pointerId: number; tab: Tab; startX: number; startY: number } | null = null

/** 按下后位移超过该值才算拖拽,避免误触点击 */
const TAB_DRAG_THRESHOLD = 6
/** 光标离开 tab 条该距离即武装拖出(上下左右四向死区) */
const TAB_DETACH_DEAD_ZONE = 24

function onTabPointerDown(e: PointerEvent, tab: Tab) {
  if (e.button !== 0) return
  // 关闭按钮不参与拖拽
  if ((e.target as HTMLElement).closest('.tab-close')) return
  const el = e.currentTarget as HTMLElement
  tabPointerDrag = { pointerId: e.pointerId, tab, startX: e.clientX, startY: e.clientY }
  // 捕获指针:拖出窗口外仍能持续收到 move/up,在外部松开也能拿到落点坐标
  try { el.setPointerCapture(e.pointerId) } catch {}
  window.addEventListener('pointermove', onTabPointerMove)
  window.addEventListener('pointerup', onTabPointerUp)
  window.addEventListener('pointercancel', onTabPointerCancel)
  window.addEventListener('keydown', onTabDragKeydown)
}

function onTabPointerMove(e: PointerEvent) {
  const drag = tabPointerDrag
  if (!drag || e.pointerId !== drag.pointerId) return
  if (!tabDragState.value?.dragging) {
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (Math.hypot(dx, dy) < TAB_DRAG_THRESHOLD) return
    document.body.classList.add('tab-dragging')
  }
  const rect = tabStripRef.value?.getBoundingClientRect()
  const inDeadZone = !!rect &&
    e.clientX >= rect.left - TAB_DETACH_DEAD_ZONE &&
    e.clientX <= rect.right + TAB_DETACH_DEAD_ZONE &&
    e.clientY >= rect.top - TAB_DETACH_DEAD_ZONE &&
    e.clientY <= rect.bottom + TAB_DETACH_DEAD_ZONE
  tabDragState.value = {
    tabId: drag.tab.id,
    clientX: e.clientX,
    clientY: e.clientY,
    dragging: true,
    detachArmed: !inDeadZone,
  }
}

async function onTabPointerUp(e: PointerEvent) {
  const drag = tabPointerDrag
  if (!drag || e.pointerId !== drag.pointerId) return
  cleanupTabPointerDrag()
  const state = tabDragState.value
  tabDragState.value = null
  if (!state?.dragging) return // 位移不足 = 普通点击,交给 @click
  suppressNextTabClick()
  if (!state.detachArmed) return
  await detachTab(drag.tab, { x: e.clientX, y: e.clientY })
}

function onTabPointerCancel(e: PointerEvent) {
  if (!tabPointerDrag || e.pointerId !== tabPointerDrag.pointerId) return
  cancelTabDrag()
}

/** Esc 取消拖拽 */
function onTabDragKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !tabPointerDrag) return
  cancelTabDrag()
}

function cancelTabDrag() {
  const wasDragging = tabDragState.value?.dragging
  cleanupTabPointerDrag()
  tabDragState.value = null
  if (wasDragging) suppressNextTabClick()
}

function cleanupTabPointerDrag() {
  tabPointerDrag = null
  window.removeEventListener('pointermove', onTabPointerMove)
  window.removeEventListener('pointerup', onTabPointerUp)
  window.removeEventListener('pointercancel', onTabPointerCancel)
  window.removeEventListener('keydown', onTabDragKeydown)
  document.body.classList.remove('tab-dragging')
}

/** pointer capture 会让拖拽后的 click 仍派发到源 tab,需屏蔽一次。
 *  不用定时器(click 派发若被事件循环延迟,定时器可能提前失效):
 *  注册一次性 capture 监听器吞掉那次 click;若拖拽后根本没有 click 派发
 *  (如在窗口外松开),则在用户下一次 pointerdown 时撤掉,避免误吞正常点击。 */
let swallowClickHandler: ((e: Event) => void) | null = null

function removeClickSwallower() {
  if (!swallowClickHandler) return
  window.removeEventListener('click', swallowClickHandler, true)
  swallowClickHandler = null
}

function suppressNextTabClick() {
  removeClickSwallower()
  swallowClickHandler = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    removeClickSwallower()
  }
  window.addEventListener('click', swallowClickHandler, true)
  window.addEventListener('pointerdown', removeClickSwallower, { capture: true, once: true })
}

/** tab 点击:拖拽刚结束的那次 click 已被 capture 阶段的吞听器拦截 */
function onTabClick(tab: Tab) {
  selectTab(tab)
}

/** 把 tab 拖出为一个独立窗口(右键菜单 / 拖拽落点两条入口共用) */
async function detachTab(tab: Tab, clientPos?: { x: number; y: number }) {
  if (!appWindow) return
  const routePath = router.resolve({ name: routeNameForTab(tab), params: { id: tab.id } }).fullPath
  const label = detachedLabelFor(tab.id)

  // 同一 tab 的独立窗口已存在 → 聚焦,不重复创建
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.setFocus()
      return
    }
  } catch {}

  // 通知主窗口里缓存的 keep-alive 组件实例:
  // 停止消费该会话的数据(后端 session 保留,等独立窗口附加)
  window.dispatchEvent(new CustomEvent(LOCAL_TAB_DETACH_EVENT, { detail: { id: tab.id } }))

  // 拖出期间保留该 tab 的 keep-alive 缓存:实例只是失活,不会被裁剪卸载,
  // 后端 session 由它继续持有,送回时原实例带终端历史直接复活
  if (!detachedKeepAlivePaths.value.includes(routePath)) {
    detachedKeepAlivePaths.value.push(routePath)
  }

  // 拖拽落点(client 坐标)→ 新窗口的屏幕物理坐标
  let position: { x: number; y: number } | undefined
  if (clientPos) {
    try {
      const [scale, inner] = await Promise.all([appWindow.scaleFactor(), appWindow.innerPosition()])
      position = {
        x: inner.x + Math.round(clientPos.x * scale) - 240,
        y: inner.y + Math.round(clientPos.y * scale) - 16,
      }
    } catch {}
  }

  const win = new WebviewWindow(label, {
    url: buildDetachedUrl(routePath, tab.title, tab.type, tab.assetId),
    title: `${tab.title} — StarHub`,
    width: 980,
    height: 700,
    minWidth: 520,
    minHeight: 360,
    decorations: false,
    backgroundColor: '#080d14',
    ...(position ? { x: position.x, y: position.y } : {}),
  })
  void win.once('tauri://error', (error) => {
    console.error('[detach] create window failed:', error)
  })

  // 从主窗口 tab 条移除(复用 closeTab 的路由回退逻辑)
  closeTab(tab.id)
}

/** 独立窗口 → 主窗口:tab 被送回,重新挂上 tab 条并激活 */
function onTabReattach(event: { payload: Tab }) {
  const tab = event.payload
  if (!tab?.id || !tab?.assetId) return
  // 送回的 tab 重新由 appStore.tabs 驱动 include,移出"拖出保留"清单
  const routePath = router.resolve({ name: routeNameForTab(tab), params: { id: tab.id } }).fullPath
  detachedKeepAlivePaths.value = detachedKeepAlivePaths.value.filter(p => p !== routePath)
  if (appStore.tabs.find(t => t.id === tab.id)) {
    appStore.setActiveTab(tab.id)
  } else {
    appStore.addTab(tab)
  }
  router.push({ name: routeNameForTab(tab), params: { id: tab.id } })
}

// ====== 独立窗口(被拖出的一侧) ======
let reattachStarted = false

/** 把 tab 送回主窗口,然后销毁自己(标题栏送回按钮 / 关闭按钮 / 窗口 X 共用) */
async function reattachToMainWindow() {
  if (!detachedInfo || reattachStarted) return
  reattachStarted = true
  try {
    await emitTo('main', TAB_REATTACH_EVENT, {
      id: detachedInfo.instanceId,
      assetId: detachedInfo.assetId,
      title: detachedInfo.title,
      type: detachedInfo.type,
    })
  } catch (error) {
    // 主窗口已不在 → 直接销毁自己
    console.warn('[detach] reattach emit failed:', error)
  }
  // 留一个事件往返的余量再自杀
  window.setTimeout(() => {
    appWindow?.destroy().catch(() => {})
  }, 80)
}

// ====== 欢迎页 stagger 交错入场 ======
const welcomeRef = ref<HTMLElement | null>(null)
const welcomeStaggerRun = ref(false)
function triggerWelcomeStagger() {
  if (appStore.tabs.length !== 0) return
  welcomeStaggerRun.value = false
  nextTick(() => {
    if (!welcomeRef.value) return
    const children = welcomeRef.value.children
    for (let i = 0; i < children.length; i++) {
      ;(children[i] as HTMLElement).style.setProperty('--i', String(i))
    }
    // 后台/隐藏标签页 rAF 不触发,补一个超时兜底,否则欢迎页会一直透明
    let fired = false
    const start = () => {
      if (fired) return
      fired = true
      welcomeStaggerRun.value = true
      runWelcomeCountUp()
      runWelcomeTypewriter()
    }
    requestAnimationFrame(start)
    window.setTimeout(start, 120)
  })
}
vueWatch(() => appStore.tabs.length, (len) => {
  if (len === 0) triggerWelcomeStagger()
})

onMounted(async () => {
  // 平台检测(Mac 修饰键显示 + Linux 拖拽兜底)
  const ua = navigator.userAgent.toLowerCase()
  isMac.value = /mac|iphone|ipad|ipod/.test(ua)
  isLinux.value = /linux/.test(ua) && !/android/.test(ua)

  // ===== 独立窗口模式:精简初始化,不挂主窗口的快捷键/时钟/tab 逻辑 =====
  if (detachedInfo) {
    // 必须等资产加载完再挂工作区:SshTerminal / DbView / DockerView 等组件
    // onMounted 时若 assetStore 仍为空,会误判"资产已被删除"把路由推回 '/',
    // 独立窗口工作区白屏(此前 fetchAssets 不 await,存在加载竞态)。
    await assetStore.fetchAssets().catch((e) => {
      console.warn('[detach] fetchAssets failed:', e)
    })
    transferStore.ensureInit()
    await refreshMaximized()
    try {
      await appWindow?.onResized(async () => { await refreshMaximized() })
    } catch {}
    // 直达拖出 tab 的工作区路由
    router.replace(detachedInfo.route)
    // 关闭窗口(X / 系统关闭)= 把 tab 送回主窗口,防止误关丢会话
    try {
      await appWindow?.onCloseRequested(async (event) => {
        event.preventDefault()
        await reattachToMainWindow()
      })
    } catch {}
    return
  }

  triggerWelcomeStagger()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keydown', onGlobalKeydown)
  updateClock()
  clockTimer = window.setInterval(updateClock, 1000)
  await refreshMaximized()
  // 监听 Tauri 窗口状态变化,同步 isMaximized
  try {
    await appWindow?.onResized(async () => { await refreshMaximized() })
  } catch {}
  // 初始化标签页滚动状态
  setTimeout(updateTabScrollState, 100)
  // 启动时从 SQLite 拉一次资产(之前是 TODO,没人调,导致重启后侧栏看起来"链接全没了")
  // 包在 try 里,失败不阻塞 UI(后端未就绪也能用)
  assetStore.fetchAssets().catch((e) => {
    console.warn('[layout] fetchAssets failed:', e)
  })
  // 全局传输任务栏:挂一次 SFTP 进度/状态事件监听(窗口生命周期内有效)
  transferStore.ensureInit()
  appStore.startAlertCheck()
  // 监听独立窗口把 tab 送回来
  try {
    await tauriListen<Tab>(TAB_REATTACH_EVENT, onTabReattach)
  } catch {}
  // 主窗口关闭时,把所有拖出的独立窗口一起销毁,避免留下孤儿窗口
  try {
    await appWindow?.onCloseRequested(async () => {
      try {
        const wins = await getAllWebviewWindows()
        await Promise.all(
          wins.filter(w => w.label.startsWith('detach-')).map(w => w.destroy())
        )
      } catch {}
    })
  } catch {}
})

onBeforeUnmount(() => {
  appStore.stopAlertCheck()
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keydown', onGlobalKeydown)
  if (clockTimer !== null) {
    window.clearInterval(clockTimer)
    clockTimer = null
  }
  // 欢迎页动效计时器
  cancelAnimationFrame(welcomeCountRaf)
  window.clearInterval(welcomeTypeTimer)
})

// ====== 标签栏 + 号:基于当前 tab 类型弹资产选择器,选哪条就开哪条 ======
const newTabPicker = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)
function closeNewTabPicker() { newTabPicker.value = null }

// ====== 标签栏空隙右键菜单(空 tab 区) ======
const tabBarCtxMenu = ref<{ x: number; y: number } | null>(null)
function closeTabBarContextMenu() { tabBarCtxMenu.value = null }

// ====== 工作区右键菜单(空白区 / 欢迎页 / 模块卡片) ======
const workspaceCtxMenu = ref<{ x: number; y: number; preferredType?: 'ssh' | 'db' | 'docker' | 'excel' } | null>(null)
function closeWorkspaceContextMenu() { workspaceCtxMenu.value = null }

function openWorkspaceContextMenu(e: MouseEvent, preferredType?: 'ssh' | 'db' | 'docker' | 'excel') {
  e.preventDefault()
  e.stopPropagation()
  closeFloatingSurfaces()
  workspaceCtxMenu.value = { x: e.clientX, y: e.clientY, preferredType }
}

function openCommandPalette() {
  closeFloatingSurfaces()
  window.dispatchEvent(new CustomEvent('starhub:open-command-palette'))
}

function preferredTypeLabel(type: 'ssh' | 'db' | 'docker' | 'excel') {
  if (type === 'ssh') return 'SSH 连接'
  if (type === 'db') return '数据库连接'
  if (type === 'docker') return 'Docker 主机'
  return 'Excel 文件'
}

const workspaceCtxItems = computed<MenuItem[]>(() => {
  const preferredType = workspaceCtxMenu.value?.preferredType
  const items: MenuItem[] = [
    { type: 'header', icon: preferredType ? getIcon(preferredType) : 'mdi-view-dashboard-outline', label: preferredType ? preferredTypeLabel(preferredType) : '工作区' },
  ]

  if (preferredType) {
    items.push(
      {
        type: 'item',
        icon: getIcon(preferredType),
        label: `打开最近的 ${preferredTypeLabel(preferredType)}…`,
        onClick: () => onWelcomeQuickAction(preferredType)
      },
      {
        type: 'item',
        icon: 'mdi-plus',
        label: `新建${preferredTypeLabel(preferredType)}…`,
        onClick: () => openNewConnectionWithType(preferredType)
      },
      { type: 'divider' }
    )
  }

  items.push(
    {
      type: 'item',
      icon: 'mdi-console',
      label: '新建 SSH 连接…',
      onClick: () => openNewConnectionWithType('ssh')
    },
    {
      type: 'item',
      icon: 'mdi-database',
      label: '新建数据库连接…',
      onClick: () => openNewConnectionWithType('db')
    },
    {
      type: 'item',
      icon: 'mdi-docker',
      label: '新建 Docker 主机…',
      onClick: () => openNewConnectionWithType('docker')
    },
    {
      type: 'item',
      icon: 'mdi-file-excel-outline',
      label: '新建 Excel 文件…',
      onClick: () => openNewConnectionWithType('excel')
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-magnify-expand',
      label: '打开命令面板',
      shortcut: `${modKey.value}P`,
      onClick: openCommandPalette
    },
    {
      type: 'item',
      icon: appStore.sidebarOpen ? 'mdi-page-layout-sidebar-left-collapse' : 'mdi-page-layout-sidebar-left-expand',
      label: appStore.sidebarOpen ? '收起侧边栏' : '展开侧边栏',
      shortcut: `${modKey.value}B`,
      onClick: () => appStore.toggleSidebar()
    },
    {
      type: 'item',
      icon: appStore.rightPanelOpen ? 'mdi-page-layout-sidebar-right-collapse' : 'mdi-page-layout-sidebar-right-expand',
      label: appStore.rightPanelOpen ? '收起右侧面板' : '展开右侧面板',
      shortcut: `${modKey.value}+Shift+B`,
      onClick: () => appStore.toggleRightPanel()
    },
    {
      type: 'item',
      icon: 'mdi-cog-outline',
      label: t('settings.title'),
      shortcut: `${modKey.value},`,
      onClick: () => openSettings()
    }
  )
  return items
})

const tabBarCtxItems = computed<MenuItem[]>(() => {
  const hasTabs = appStore.tabs.length > 0
  const hasActive = !!appStore.activeTab
  return [
    { type: 'header', icon: 'mdi-tab', label: '标签栏' },
    {
      type: 'item',
      icon: 'mdi-console',
      label: '新建 SSH 连接…',
      onClick: () => openNewConnectionWithType('ssh')
    },
    {
      type: 'item',
      icon: 'mdi-database',
      label: '新建数据库连接…',
      onClick: () => openNewConnectionWithType('db')
    },
    {
      type: 'item',
      icon: 'mdi-docker',
      label: '新建 Docker 主机…',
      onClick: () => openNewConnectionWithType('docker')
    },
    {
      type: 'item',
      icon: 'mdi-file-excel-outline',
      label: '新建 Excel 文件…',
      onClick: () => openNewConnectionWithType('excel')
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-close',
      label: '关闭当前标签页',
      shortcut: 'Ctrl+W',
      disabled: !hasActive,
      onClick: () => { if (appStore.activeTab) closeTab(appStore.activeTab) }
    },
    {
      type: 'item',
      icon: 'mdi-arrow-right',
      label: '关闭所有',
      danger: true,
      disabled: !hasTabs,
      onClick: () => {
        for (const t of [...appStore.tabs]) appStore.removeTab(t.id)
        // tabs 清空后,workspace 自动落到欢迎页(v-if="tabs.length === 0" 分支)
      }
    }
  ]
})

/** 标签栏空隙右键统一入口 */
function openTabBarContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  tabBarCtxMenu.value = { x: e.clientX, y: e.clientY }
  // 关闭可能并存的 tab 单体菜单
  closeTabContextMenu()
}

/** 预设类型打开新建连接弹窗 */
function openNewConnectionWithType(type: 'ssh' | 'db' | 'docker' | 'excel') {
  newConnectionInitialType.value = type
  showNewConnection.value = true
}

function openNewTabFromCurrent(e: MouseEvent) {
  // 推断当前 tab 类型
  const active = appStore.tabs.find(t => t.id === appStore.activeTab)
  if (active?.type === 'ai') {
    const items: MenuItem[] = [
      { type: 'header', icon: 'mdi-robot-outline', label: t('ai.agents') },
      ...aiStore.agents.map(agent => ({
        type: 'item' as const,
        icon: 'mdi-robot-outline',
        label: agent.name,
        onClick: () => openAiAgentTab(agent, false)
      })),
      { type: 'divider' },
      {
        type: 'item',
        icon: 'mdi-plus',
        label: t('ai.newAgent'),
        onClick: () => window.dispatchEvent(new CustomEvent('starhub:new-ai-agent'))
      }
    ]
    const target = e.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    newTabPicker.value = { x: rect.left, y: rect.bottom + 4, items }
    return
  }
  let assetType: 'ssh' | 'db' | 'docker' | 'excel' = 'ssh'
  if (active?.type === 'db') assetType = 'db'
  else if (active?.type === 'docker') assetType = 'docker'
  else if (active?.type === 'excel') assetType = 'excel'

  const list = assetStore.assets.filter(a => a.type === assetType)
  if (list.length === 0) {
    // 没该类型资产,直接弹新建连接
    showNewConnection.value = true
    return
  }
  // 弹选择器(贴 + 按钮下方)
  const headerLabel = assetType === 'ssh' ? '打开 SSH 终端'
    : assetType === 'db' ? '打开数据库连接'
    : assetType === 'docker' ? '打开 Docker 主机'
    : '打开 Excel 文件'
  const items: MenuItem[] = [
    { type: 'header', icon: getIcon(assetType), label: headerLabel },
    ...list.map(a => ({
      type: 'item' as const,
      icon: getIcon(assetType),
      label: a.name,
      onClick: () => {
        openAssetTab(a, false)
      }
    })),
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-plus',
      label: '新建连接…',
      onClick: () => {
        showNewConnection.value = true
      }
    }
  ]
  // 用 + 按钮位置作为弹出位置
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  newTabPicker.value = { x: rect.left, y: rect.bottom + 4, items }
}
const userMenuOpen = ref(false)
function toggleUserMenu() { userMenuOpen.value = !userMenuOpen.value }
function closeUserMenu() { userMenuOpen.value = false }

function onUserMenuAction(action: 'settings' | 'theme' | 'lang' | 'about' | 'quick-db' | 'quick-docker') {
  closeUserMenu()
  switch (action) {
    case 'settings':
      openSettings()
      break
    case 'theme':
      themeStore.setTheme(themeStore.theme === 'darkTheme' ? 'lightTheme' : 'darkTheme')
      break
    case 'lang':
      locale.value = locale.value === 'zh-CN' ? 'en-US' : 'zh-CN'
      break
    case 'about':
      void dlg.alert({
        title: `StarHub v${appVersion}`,
        message: `跨平台 DevOps 桌面工具\nGitHub: github.com/dabaicai001/starhub`,
        color: 'info',
      })
      break
  }
}

/** 欢迎页 CAPABILITIES 卡片点击:有同类资产跳最近一条,没有弹新建 dialog(预设类型) */
function onWelcomeQuickAction(type: 'ssh' | 'db' | 'docker' | 'excel') {
  const sameType = assetStore.assets.filter(a => a.type === type)
  if (sameType.length > 0) {
    // 跳最近用过的一条,优先激活已有标签
    const a = sameType.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0]
    openAssetTab(a, true)
  } else {
    // 0 同类资产 → 弹新建 dialog 并预设类型
    newConnectionInitialType.value = type
    nextTick(() => { showNewConnection.value = true })
  }
}

// 点页面其他地方关闭用户菜单
function onDocClick(e: PointerEvent) {
  if (!userMenuOpen.value) return
  const target = e.target as HTMLElement
  if (!target.closest('.user-menu')) {
    userMenuOpen.value = false
  }
}
onMounted(() => window.addEventListener('pointerdown', onDocClick))
onBeforeUnmount(() => window.removeEventListener('pointerdown', onDocClick))

// 监听来自 CommandPalette 的"新建连接"事件
function onNewConnectionEvent() {
  showNewConnection.value = true
}
onMounted(() => window.addEventListener('starhub:new-connection', onNewConnectionEvent))
onBeforeUnmount(() => window.removeEventListener('starhub:new-connection', onNewConnectionEvent))

// 监听来自 CommandPalette 的"打开设置"事件
function onOpenSettingsEvent() {
  openSettings()
}
onMounted(() => window.addEventListener('starhub:open-settings', onOpenSettingsEvent))
onBeforeUnmount(() => window.removeEventListener('starhub:open-settings', onOpenSettingsEvent))

function onOpenAiSettingsEvent() {
  openSettings('ai')
}
onMounted(() => window.addEventListener('starhub:open-ai-settings', onOpenAiSettingsEvent))
onBeforeUnmount(() => window.removeEventListener('starhub:open-ai-settings', onOpenAiSettingsEvent))

const filteredAssets = computed(() => {
  const raw = assetStore.searchQuery
  if (!raw) return assetStore.assets
  const query = raw.toLowerCase()
  return assetStore.assets.filter(asset =>
    asset.name.toLowerCase().includes(query) ||
    asset.config.host?.toLowerCase().includes(query)
  )
})

// ====== 顶部导航菜单(已删除) ======
// 之前有一行 6 个导航按钮(首页/资产中心/终端/数据库/Docker/AI 助手),
// 现在改用侧边栏资产树 + 顶部 + 号新建,这里只保留资产选择器辅助。

// ====== 顶部菜单 → 资产选择器 ======
// 点击"终端 / 数据库 / Docker"时:有该类型资产就弹出选择菜单,点哪条就开哪条;
// 一个都没有就回退到"新建连接"流程。
const assetPicker = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)
function closeAssetPicker() { assetPicker.value = null }

function assetTypeIcon(t: 'ssh' | 'db' | 'docker' | 'excel') {
  return t === 'ssh' ? 'mdi-console' : t === 'db' ? 'mdi-database' : t === 'docker' ? 'mdi-docker' : 'mdi-file-excel-outline'
}

function openAssetPicker(e: MouseEvent, assetType: 'ssh' | 'db' | 'docker' | 'excel', _openRoute: string) {
  const list = assetStore.assets.filter(a => a.type === assetType)
  if (list.length === 0) {
    // 没有该类型资产,直接走"新建连接"
    showNewConnection.value = true
    return
  }
  // 有就弹选择器;点哪条开哪条
  const headerLabel = assetType === 'ssh' ? '打开 SSH 终端'
    : assetType === 'db' ? '打开数据库连接'
    : assetType === 'docker' ? '打开 Docker 主机'
    : '打开 Excel 文件'
  const items: MenuItem[] = [
    { type: 'header', icon: assetTypeIcon(assetType), label: headerLabel },
    ...list.map(a => ({
      type: 'item' as const,
      icon: assetTypeIcon(assetType),
      label: a.name,
      onClick: () => {
        openAssetTab(a, true)
      }
    })),
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-plus',
      label: assetType === 'ssh' ? '新建 SSH 连接...'
        : assetType === 'db' ? '新建数据库连接...'
        : '新建 Docker 主机...',
      onClick: () => {
        showNewConnection.value = true
      }
    }
  ]
  assetPicker.value = { x: e.clientX, y: e.clientY + 4, items }
}

const sshAssets = computed(() => filteredAssets.value.filter(a => a.type === 'ssh'))
const dbAssets = computed(() => filteredAssets.value.filter(a => a.type === 'db'))
const dockerAssets = computed(() => filteredAssets.value.filter(a => a.type === 'docker'))
const excelAssets = computed(() => filteredAssets.value.filter(a => a.type === 'excel'))

// 时钟(每秒更新)
const clockText = ref('')
let clockTimer: number | null = null
function updateClock() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  clockText.value = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function getIcon(type: string) {
  switch (type) {
    case 'ssh': return 'mdi-console'
    case 'db': return 'mdi-database'
    case 'docker': return 'mdi-docker'
    case 'excel': return 'mdi-file-excel-outline'
    case 'ai': return 'mdi-robot-outline'
    case 'web': return 'mdi-web'
    case 'settings': return 'mdi-cog-outline'
    default: return 'mdi-file'
  }
}

/** DB 类型徽章文本 / 资产路由名 / 开 tab:统一走 @/utils/assetRouting */
function getStatusColor(asset: Asset) {
  return asset.lastUsedAt ? 'online' : 'offline'
}

function routeNameForTab(tab: { assetId?: string; type: string }): string {
  if (tab.type === 'ai') return 'ai'
  // web tab 的 assetId 存的是 SSH 会话 id(不是资产),不能走资产查找
  if (tab.type === 'web') return 'web-browser'
  const asset = tab.assetId ? assetStore.assets.find(a => a.id === tab.assetId) : null
  if (asset) return routeNameForAsset(asset)
  if (tab.type === 'ssh') return 'ssh-terminal'
  if (tab.type === 'docker') return 'docker'
  if (tab.type === 'excel') return 'excel'
  return 'db-mysql'
}

// ====== keep-alive 按 tab 精确裁剪缓存 ======
// keep-alive 的 include 只匹配组件 name,不匹配 key;同一类 tab(如多个 SSH)
// 共享同一个路由组件,直接 include 组件名无法在关闭单个 tab 时卸载对应缓存实例,
// SshTerminal 的 onBeforeUnmount 清理(断连 / unlisten)永远不触发。
// 做法:为每个 route.fullPath 生成一个以路径命名的薄包装组件(每 tab 稳定复用),
// include 由「当前仍打开的 tab 的路径名」驱动 —— 关闭 tab 后其包装名从 include
// 消失,keep-alive 立即裁剪并真正 unmount 该实例。
// 独立(detached)窗口的 router-view 不套 keep-alive,不受此影响。
const keepAliveWrapperCache = new Map<string, Component>()

function keepAliveNameFor(fullPath: string): string {
  return `tab-${encodeURIComponent(fullPath)}`
}

function keepAliveComponent(inner: VNode | undefined, fullPath: string): Component | undefined {
  if (!inner) return undefined
  let wrapper = keepAliveWrapperCache.get(fullPath)
  if (!wrapper) {
    const vnode = inner
    wrapper = defineComponent({
      name: keepAliveNameFor(fullPath),
      setup: () => () => cloneVNode(vnode)
    })
    keepAliveWrapperCache.set(fullPath, wrapper)
  }
  return wrapper
}

// 拖出的 tab 会从 appStore.tabs 移除,但它的 keep-alive 实例仍持有主窗口侧
// 后端会话(SshTerminal 的 silencedForDetach 机制):拖出期间继续保留其缓存,
// 送回时原实例带着终端历史直接 onActivated 复活,而不是被裁剪卸载后误断连。
const detachedKeepAlivePaths = ref<string[]>([])

const keepAliveIncludes = computed(() => [
  ...appStore.tabs.map(tab =>
    keepAliveNameFor(router.resolve({ name: routeNameForTab(tab), params: { id: tab.id } }).fullPath)
  ),
  ...detachedKeepAlivePaths.value.map(keepAliveNameFor)
])

function openAiAgentTab(agent: AiAgent, reuseExisting = true) {
  if (reuseExisting) {
    const existing = appStore.tabs.find(tab => tab.type === 'ai' && tab.assetId === agent.id)
    if (existing) {
      appStore.setActiveTab(existing.id)
      router.push({ name: 'ai', params: { id: existing.id } })
      return
    }
  }
  const instanceId = generateInstanceId(`ai-${agent.id}`)
  appStore.addTab({ id: instanceId, assetId: agent.id, title: agent.name, type: 'ai' })
  router.push({ name: 'ai', params: { id: instanceId } })
}

function openAssetTab(asset: Asset, reuseExisting = true) {
  openAssetTabRouting(asset, reuseExisting, router)
}

function _placeholder() {}

function getTabDisplayTitle(tab: { id: string; assetId?: string; title: string; type?: string }): string {
  // ai 类型的 tab(非资产)按"同 title 出现多次"加序号
  if (!tab.assetId) {
    const sameTitleTabs = appStore.tabs.filter(t => t.title === tab.title)
    if (sameTitleTabs.length <= 1) return tab.title
    const index = sameTitleTabs.findIndex(t => t.id === tab.id)
    return `${tab.title} (${index + 1})`
  }
  // 资产 tab 按 assetId 维度加序号
  const sameAssetTabs = appStore.tabs.filter(t => t.assetId === tab.assetId)
  if (sameAssetTabs.length <= 1) return tab.title
  const index = sameAssetTabs.findIndex(t => t.id === tab.id)
  return `${tab.title} (${index + 1})`
}

function connectToAsset(asset: Asset) {
  openAssetTab(asset, true)
}

// `openSftpForAsset` 已迁移到 AssetTree.vue 的右键菜单
// (SFTP拆为独立工具后,逻辑跟着 UI走),这里不再保留死代码。

function openNewConnection() {
  showNewConnection.value = true
}

async function handleNewConnection(dto: CreateAssetDto) {
  const asset = await assetStore.createAsset(dto)
  openAssetTab(asset, false)
}

function navigateTo(path: string) {
  router.push(path)
}

function selectTab(tab: { id: string; assetId?: string; type: string }) {
  appStore.setActiveTab(tab.id)
  router.push({ name: routeNameForTab(tab), params: { id: tab.id } })
}

function closeTab(tabId: string) {
  const tab = appStore.tabs.find((t) => t.id === tabId)
  appStore.removeTab(tabId)
  if (appStore.tabs.length === 0) {
    // tabs 清空后,workspace 自动落到欢迎页(v-if="tabs.length === 0" 分支)
    // 同时把路由拉回 '/',URL 跟着清掉
    router.push('/')
    return
  }
  // 关闭后,跳到当前激活 tab(用 instanceId 跳路由)
  if (appStore.activeTab) {
    const activeTab = appStore.tabs.find(t => t.id === appStore.activeTab)
    if (activeTab) {
      selectTab(activeTab)
    }
  }
}

// ====== 标签页右键菜单 ======
const tabCtxMenu = ref<{ x: number; y: number; tab: { id: string; type: string; title: string } } | null>(null)

function openTabContextMenu(e: MouseEvent, tab: { id: string; type: string; title: string }) {
  e.preventDefault()
  e.stopPropagation()
  tabCtxMenu.value = { x: e.clientX, y: e.clientY, tab }
}

function closeTabContextMenu() {
  tabCtxMenu.value = null
}

const tabCtxItems = computed<MenuItem[]>(() => {
  if (!tabCtxMenu.value) return []
  const { tab } = tabCtxMenu.value
  const idx = appStore.tabs.findIndex(t => t.id === tab.id)
  const hasLeft = idx > 0
  const hasRight = idx >= 0 && idx < appStore.tabs.length - 1
  const others = appStore.tabs.filter(t => t.id !== tab.id)
  const activeId = appStore.activeTab
  const currentTab = appStore.tabs.find(t => t.id === tab.id)
  const sameAssetTabs = currentTab?.assetId ? appStore.tabs.filter(t => t.assetId === currentTab.assetId && t.id !== tab.id) : []
  return [
    {
      type: 'header',
      icon: getIcon(tab.type),
      label: getTabDisplayTitle(tab as any)
    },
    {
      type: 'item',
      icon: 'mdi-close',
      label: t('layout.closeTab'),
      shortcut: 'Ctrl+W',
      onClick: () => closeTab(tab.id)
    },
    {
      type: 'item',
      icon: 'mdi-close-circle-outline',
      label: t('layout.closeOtherTabs'),
      disabled: others.length === 0,
      onClick: () => {
        // 关闭除当前外的所有
        for (const t of [...appStore.tabs]) {
          if (t.id !== tab.id) appStore.removeTab(t.id)
        }
        // 跳到当前
        selectTab(tab as any)
      }
    },
    {
      type: 'item',
      icon: 'mdi-close-circle-outline',
      label: t('layout.closeSameAssetTabs'),
      disabled: sameAssetTabs.length === 0,
      onClick: () => {
        for (const t of sameAssetTabs) {
          appStore.removeTab(t.id)
        }
      }
    },
    {
      type: 'item',
      icon: 'mdi-arrow-collapse-right',
      label: t('layout.closeRightTabs'),
      disabled: !hasRight,
      onClick: () => {
        const right = appStore.tabs.slice(idx + 1)
        for (const t of right) appStore.removeTab(t.id)
        // 如果 active 在被关的里面,跳回当前
        if (activeId && !appStore.tabs.find(t => t.id === activeId)) {
          selectTab(tab as any)
        }
      }
    },
    { type: 'divider' },
    {
      type: 'item',
      icon: 'mdi-open-in-new',
      label: t('layout.detachTab'),
      onClick: () => {
        const full = appStore.tabs.find(t => t.id === tab.id)
        if (full) void detachTab(full)
      }
    },
    {
      type: 'item',
      icon: 'mdi-content-duplicate',
      label: t('layout.copyTabTitle'),
      onClick: async () => {
        try { await navigator.clipboard.writeText(tab.title) } catch {}
      }
    },
    {
      type: 'item',
      icon: 'mdi-arrow-right',
      label: t('layout.closeAllTabs'),
      danger: true,
      disabled: appStore.tabs.length === 0,
      onClick: () => {
        for (const t of [...appStore.tabs]) appStore.removeTab(t.id)
        // tabs 清空后,workspace 自动落到欢迎页(v-if="tabs.length === 0" 分支)
        router.push('/')
      }
    }
  ]
})

// Ctrl+W 关闭当前
function onGlobalKeydown(e: KeyboardEvent) {
  if (showNewConnection.value || showSettings.value || dlg.visible || isEditableEventTarget(e.target)) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && appStore.activeTab) {
    e.preventDefault()
    closeTab(appStore.activeTab)
    return
  }
  // 欢迎页(无任何标签页)按 N 新建连接,与首页按钮上的 kbd 提示对应
  if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'n' && appStore.tabs.length === 0) {
    e.preventDefault()
    openNewConnection()
  }
}

// ====== 标签页溢出滚动 ======
const tabStripRef = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

/** 最近用过的资产(有 lastUsedAt 且非 docker)— 用于 tab 栏空态快速启动条 */
const recentAssets = computed(() => {
  return [...assetStore.assets]
    .filter(a => a.lastUsedAt)
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .slice(0, 6)
})

const onboardingSteps = computed(() => [
  {
    icon: 'mdi-plus-circle-outline',
    title: '创建第一个连接',
    desc: 'SSH、数据库、Docker 或 Excel 文件都可以作为起点',
    done: assetStore.assets.length > 0,
    action: () => openNewConnection()
  },
  {
    icon: 'mdi-lan-connect',
    title: '打开一个工作区',
    desc: '双击侧边栏资产,或用 Ctrl+K 搜索打开',
    done: appStore.tabs.length > 0,
    action: () => openCommandPalette()
  },
  {
    icon: 'mdi-robot-outline',
    title: '让 AI 接管上下文',
    desc: '进入 DB / Docker / Excel 后,右侧 AI 会带上当前上下文',
    done: false,
    action: () => { appStore.rightPanelOpen = true }
  }
])

type WelcomeModuleType = 'ssh' | 'db' | 'docker' | 'excel'

const welcomeModules: Array<{
  type: WelcomeModuleType
  icon: string
  iconClass: string
  title: string
  desc: string
  detail: string
}> = [
  {
    type: 'ssh',
    icon: 'mdi-console',
    iconClass: 'ssh',
    title: 'SSH 终端',
    desc: '连接服务器、执行命令、配合 SFTP 管理文件',
    detail: '终端 / SFTP / 批量操作'
  },
  {
    type: 'db',
    icon: 'mdi-database',
    iconClass: 'db',
    title: '数据库工作台',
    desc: '统一管理 MySQL、PostgreSQL、SQLite、Redis 等连接',
    detail: 'SQL 编辑 / 数据浏览 / Redis 工具'
  },
  {
    type: 'docker',
    icon: 'mdi-docker',
    iconClass: 'docker',
    title: 'Docker 面板',
    desc: '查看容器、镜像和运行状态,后续支持远程 Docker',
    detail: '容器 / 镜像 / 资源概览'
  },
  {
    type: 'excel',
    icon: 'mdi-file-excel-outline',
    iconClass: 'excel',
    title: 'Excel 工具',
    desc: '处理表格、导入导出数据库结果和运维清单',
    detail: '编辑 / 导入 / 导出'
  }
]

function maturityLabel(type: WelcomeModuleType) {
  if (type === 'excel') return 'Stable'
  if (type === 'db') return 'P0 Core'
  return 'Beta'
}

function moduleAssetCount(type: WelcomeModuleType) {
  if (type === 'ssh') return sshAssets.value.length
  if (type === 'db') return dbAssets.value.length
  if (type === 'docker') return dockerAssets.value.length
  return excelAssets.value.length
}

// ====== 欢迎页动效:指标数字滚动 + 标语打字机 + 漂浮粒子 ======
const welcomeMetrics = computed(() => [
  { icon: 'mdi-console', label: 'SSH', value: sshAssets.value.length },
  { icon: 'mdi-database', label: 'Database', value: dbAssets.value.length },
  { icon: 'mdi-docker', label: 'Docker', value: dockerAssets.value.length },
  { icon: 'mdi-file-excel-outline', label: 'Excel', value: excelAssets.value.length }
])
const welcomeMetricDisplay = ref<number[]>([0, 0, 0, 0])
let welcomeCountRaf = 0
let welcomeCountDone = false
function runWelcomeCountUp() {
  cancelAnimationFrame(welcomeCountRaf)
  welcomeCountDone = false
  const targets = welcomeMetrics.value.map(m => m.value)
  const start = performance.now()
  const duration = 900
  const tick = (now: number) => {
    const p = Math.min((now - start) / duration, 1)
    const eased = 1 - Math.pow(1 - p, 3)
    welcomeMetricDisplay.value = targets.map(v => Math.round(v * eased))
    if (p < 1) {
      welcomeCountRaf = requestAnimationFrame(tick)
    } else {
      welcomeCountDone = true
    }
  }
  welcomeCountRaf = requestAnimationFrame(tick)
}
// 数字滚动结束后资产数变化直接同步,不再重放动画
vueWatch(welcomeMetrics, (list) => {
  if (welcomeCountDone) welcomeMetricDisplay.value = list.map(m => m.value)
})

const welcomeSloganText = ref('')
const welcomeSloganTyping = ref(false)
let welcomeTypeTimer: number | undefined
function runWelcomeTypewriter() {
  window.clearInterval(welcomeTypeTimer)
  const full = t('home.slogan')
  welcomeSloganText.value = ''
  welcomeSloganTyping.value = true
  let i = 0
  welcomeTypeTimer = window.setInterval(() => {
    i += 1
    welcomeSloganText.value = full.slice(0, i)
    if (i >= full.length) {
      window.clearInterval(welcomeTypeTimer)
      welcomeSloganTyping.value = false
    }
  }, 140)
}

const welcomeParticles = [
  { id: 0, x: '12%', y: '72%', d: '0s' },
  { id: 1, x: '28%', y: '84%', d: '2.2s' },
  { id: 2, x: '55%', y: '78%', d: '4.1s' },
  { id: 3, x: '74%', y: '86%', d: '1.3s' },
  { id: 4, x: '88%', y: '70%', d: '3.2s' },
  { id: 5, x: '42%', y: '90%', d: '5.4s' }
]

/** 紧凑时间标签(用于欢迎页最近使用面板) */
function shortTimeAgo(ts: number | null | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function updateTabScrollState() {
  const el = tabStripRef.value
  if (!el) return
  canScrollLeft.value = el.scrollLeft > 2
  canScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
}

function scrollTabs(dir: -1 | 1) {
  const el = tabStripRef.value
  if (!el) return
  el.scrollBy({ left: dir * 160, behavior: 'smooth' })
}

function onTabStripScroll() {
  updateTabScrollState()
}

// 监听 tabs 变化,刷新滚动状态
import { watch as vueWatch } from 'vue'
vueWatch(() => appStore.tabs.length, () => {
  setTimeout(updateTabScrollState, 50)
})
</script>

<template>
  <!-- ===== 独立窗口模式(从主窗口拖出的单 tab 工作区) ===== -->
  <div v-if="detachedInfo" class="detached-layout">
    <div
      class="detached-titlebar"
      data-tauri-drag-region
      @dblclick="onTitlebarDblclick"
      @mousedown="onTitlebarMousedown"
    >
      <v-icon size="13" class="detached-icon">{{ getIcon(detachedInfo.type) }}</v-icon>
      <span class="detached-title">{{ detachedInfo.title }}</span>
      <span class="detached-sub">{{ t('layout.detachedHint') }}</span>
      <div class="window-controls">
        <button
          class="win-btn"
          :data-tooltip="t('layout.reattachTab')"
          :aria-label="t('layout.reattachTab')"
          @click="reattachToMainWindow"
        >
          <v-icon size="13">mdi-arrow-u-left-bottom</v-icon>
        </button>
        <button class="win-btn" aria-label="Minimize" @click="winMinimize">
          <v-icon size="13">mdi-window-minimize</v-icon>
        </button>
        <button
          class="win-btn"
          :aria-label="isMaximized ? 'Restore' : 'Maximize'"
          @click="winToggleMaximize"
        >
          <v-icon size="13">{{ isMaximized ? 'mdi-window-restore' : 'mdi-window-maximize' }}</v-icon>
        </button>
        <button
          class="win-btn close"
          :data-tooltip="t('layout.reattachTab')"
          :aria-label="t('common.close')"
          @click="reattachToMainWindow"
        >
          <v-icon size="13">mdi-window-close</v-icon>
        </button>
      </div>
    </div>
    <div class="detached-workspace">
      <router-view v-slot="{ Component }">
        <component :is="Component" :key="route.fullPath" />
      </router-view>
    </div>
  </div>

  <div v-else class="app-layout">
    <!-- Title Bar (自画 chrome · 替代系统标题栏) -->
    <div class="titlebar" data-tauri-drag-region @dblclick="onTitlebarDblclick" @mousedown="onTitlebarMousedown">
      <div class="logo" aria-label="StarHub">
        <img :src="logoUrl" alt="StarHub" class="logo-img" />
      </div>

      <!-- 标签栏(原 menubar 横条已并入标题栏,logo 右侧) -->
      <div class="tab-strip-wrap">
        <button
          v-show="canScrollLeft"
          class="tab-scroll-btn left"
          @click="scrollTabs(-1)"
        >
          <v-icon size="12">mdi-chevron-left</v-icon>
        </button>
        <div
          ref="tabStripRef"
          class="tab-strip"
          data-tauri-drag-region
          @scroll="onTabStripScroll"
          @contextmenu="openTabBarContextMenu"
        >
          <div
            v-for="tab in appStore.tabs"
            :key="tab.id"
            class="tab"
            :class="{
              active: appStore.activeTab === tab.id,
              dragging: tabDragState?.tabId === tab.id && tabDragState?.dragging,
              'drag-armed': tabDragState?.tabId === tab.id && tabDragState?.detachArmed
            }"
            @click="onTabClick(tab)"
            @contextmenu="openTabContextMenu($event, tab)"
            @auxclick.middle.prevent="closeTab(tab.id)"
            @pointerdown="onTabPointerDown($event, tab)"
            @dblclick.stop
          >
            <v-icon size="12">{{ getIcon(tab.type) }}</v-icon>
            <span class="tab-title">{{ getTabDisplayTitle(tab) }}</span>
            <span class="tab-close" @click.stop="closeTab(tab.id)">
              <v-icon size="10">mdi-close</v-icon>
            </span>
          </div>
        </div>
        <button
          v-show="canScrollRight"
          class="tab-scroll-btn right"
          @click="scrollTabs(1)"
        >
          <v-icon size="12">mdi-chevron-right</v-icon>
        </button>
        <!-- 标签栏尾部 + 按钮:快速新建 tab -->
        <button
          class="tab-new-btn"
          :data-tooltip="t('common.new') + ' tab'"
          @click="openNewTabFromCurrent"
        >
          <v-icon size="13">mdi-plus</v-icon>
        </button>
      </div>

      <div class="top-actions">
        <div class="top-action-group">
          <button class="action-btn" @click="openSettings()" :data-tooltip="t('settings.title')">
            <v-icon size="16">mdi-cog</v-icon>
          </button>
          <NotificationCenter />
          <button class="action-btn primary" @click="openNewConnection" :data-tooltip="t('asset.create')">
            <v-icon size="16">mdi-plus</v-icon>
          </button>
        </div>

        <!-- 头像下拉菜单 -->
        <div class="user-menu" @click.stop="toggleUserMenu">
          <button class="avatar cyber-tooltip" :data-tooltip="t('user.menu')">
            <span>U</span>
          </button>
          <div v-if="userMenuOpen" class="user-menu-popup">
            <div class="user-menu-header">
              <div class="avatar-large">U</div>
              <div class="info">
                <div class="name">StarHub User</div>
                <div class="email">local@starhub.app</div>
              </div>
            </div>
            <div class="user-menu-divider" />
            <button class="user-menu-item" @click="onUserMenuAction('settings')">
              <v-icon size="14">mdi-cog-outline</v-icon>
              <span>{{ t('settings.title') }}</span>
              <kbd>Ctrl+,</kbd>
            </button>
            <button class="user-menu-item" @click="onUserMenuAction('theme')">
              <v-icon size="14">{{ themeStore.theme === 'darkTheme' ? 'mdi-weather-sunny' : 'mdi-weather-night' }}</v-icon>
              <span>{{ t('settings.theme') }}: {{ themeStore.theme === 'darkTheme' ? 'Dark' : 'Light' }}</span>
            </button>
            <button class="user-menu-item" @click="onUserMenuAction('lang')">
              <v-icon size="14">mdi-translate</v-icon>
              <span>{{ t('settings.language') }}: {{ locale === 'zh-CN' ? '中文' : 'EN' }}</span>
            </button>
            <div class="user-menu-divider" />
            <button class="user-menu-item" @click="onUserMenuAction('about')">
              <v-icon size="14">mdi-information-outline</v-icon>
              <span>关于 StarHub</span>
              <kbd>v{{ appVersion }}</kbd>
            </button>
          </div>
        </div>

        <div class="top-action-divider" />

        <!-- 自画窗口控件(min / max / close) -->
        <div class="window-controls">
          <button
            class="win-btn"
            :data-tooltip="'Minimize'"
            aria-label="Minimize"
            @click="winMinimize"
          >
            <v-icon size="14">mdi-window-minimize</v-icon>
          </button>
          <button
            class="win-btn"
            :data-tooltip="isMaximized ? 'Restore' : 'Maximize'"
            :aria-label="isMaximized ? 'Restore' : 'Maximize'"
            @click="winToggleMaximize"
          >
            <v-icon size="14">{{ isMaximized ? 'mdi-window-restore' : 'mdi-window-maximize' }}</v-icon>
          </button>
          <button
            class="win-btn close"
            data-tooltip="Close"
            aria-label="Close"
            @click="winClose"
          >
            <v-icon size="14">mdi-window-close</v-icon>
          </button>
        </div>
      </div>
    </div>

    <!-- Main Content -->
    <div class="main-content">
      <!-- Sidebar -->
      <div
        class="sidebar"
        :class="{
          collapsed: !appStore.sidebarOpen,
          dragging: appStore.sidebarDragging
        }"
        :style="{
          width: appStore.sidebarOpen
            ? appStore.sidebarWidth + 'px'
            : SIDEBAR_COLLAPSED_WIDTH + 'px'
        }"
      >
        <AssetTree
          @new-connection="openNewConnection"
          @new-connection-type="openNewConnectionWithType"
        />
        <SidebarHandle />
      </div>

      <!-- Workspace -->
      <div class="workspace">
        <div v-if="appStore.tabs.length === 0 && !devMockWorkspace" class="workspace-welcome" @contextmenu="openWorkspaceContextMenu">
          <div class="welcome-decor" aria-hidden="true">
            <template v-if="showWelcomeDecor">
              <div class="welcome-aurora welcome-aurora-a"></div>
              <div class="welcome-aurora welcome-aurora-b"></div>
              <span
                v-for="p in welcomeParticles"
                :key="p.id"
                class="welcome-particle"
                :style="{ '--x': p.x, '--y': p.y, '--d': p.d }"
              ></span>
            </template>
            <div class="welcome-grid-overlay"></div>
          </div>
          <div ref="welcomeRef" class="welcome-content cyber-stagger" :class="{ run: welcomeStaggerRun }">
            <div class="welcome-hero" style="--i: 0">
              <div class="welcome-copy">
                <div class="welcome-kicker">
                  <span class="status-dot online"></span>
                  <span>StarHub · Local workspace</span>
                  <span class="welcome-caret"></span>
                </div>
                <h2 class="welcome-title">{{ t('home.welcome') }}</h2>
                <p class="welcome-subtitle">{{ t('home.subtitle') }}</p>
                <div class="quick-actions">
                  <button class="welcome-btn welcome-btn-primary" @click="openNewConnection">
                    <v-icon size="14">mdi-plus</v-icon>
                    <span>{{ t('asset.create') }}</span>
                    <span class="welcome-btn-kbd">N</span>
                  </button>
                  <button class="welcome-btn welcome-btn-secondary" @click="openCommandPalette">
                    <v-icon size="14">mdi-magnify</v-icon>
                    <span>命令面板</span>
                    <span class="welcome-btn-kbd">{{ modKey }}P</span>
                  </button>
                </div>
                <p class="welcome-slogan">
                  <span>{{ welcomeSloganText }}</span>
                  <span v-if="welcomeSloganTyping" class="welcome-caret welcome-caret-inline"></span>
                </p>
              </div>
              <div class="welcome-metrics" aria-label="Workspace assets summary">
                <div
                  v-for="(m, i) in welcomeMetrics"
                  :key="m.label"
                  class="metric-card"
                  :style="{ '--i': i }"
                >
                  <div class="metric-top">
                    <span class="metric-icon" :style="{ '--i': i }">
                      <v-icon size="12">{{ m.icon }}</v-icon>
                    </span>
                    <span class="metric-label">{{ m.label }}</span>
                  </div>
                  <strong class="metric-value">{{ welcomeMetricDisplay[i] }}</strong>
                </div>
              </div>
            </div>

            <div class="onboarding-panel" style="--i: 1">
              <button
                v-for="(step, i) in onboardingSteps"
                :key="step.title"
                class="onboarding-step"
                :class="{ done: step.done }"
                :style="{ '--i': i }"
                @click="step.action"
              >
                <span class="step-icon">
                  <v-icon size="14">{{ step.done ? 'mdi-check' : step.icon }}</v-icon>
                </span>
                <span class="step-copy">
                  <span class="step-title">{{ step.title }}</span>
                  <span class="step-desc">{{ step.desc }}</span>
                </span>
              </button>
            </div>

            <div class="section-divider" style="--i: 2">
              <span class="section-label">Modules</span>
              <span class="section-hint">选择一个模块开始</span>
            </div>

            <div class="feature-grid" style="--i: 3">
              <button
                v-for="(module, i) in welcomeModules"
                :key="module.type"
                class="feature-card"
                :style="{ '--i': i }"
                @click="onWelcomeQuickAction(module.type)"
                @contextmenu="openWorkspaceContextMenu($event, module.type)"
              >
                <div class="feature-card-row">
                  <span class="fc-icon" :class="module.iconClass">
                    <v-icon size="14">{{ module.icon }}</v-icon>
                  </span>
                  <h3>{{ module.title }}</h3>
                  <span class="fc-count" :key="moduleAssetCount(module.type)">{{ moduleAssetCount(module.type) }}</span>
                </div>
                <p class="fc-desc">{{ module.desc }}</p>
                <span class="fc-detail">{{ module.detail }}</span>
                <span class="fc-arrow">
                  <v-icon size="14">mdi-arrow-right</v-icon>
                </span>
              </button>
            </div>

            <div v-if="recentAssets.length > 0" class="recent-work-panel" style="--i: 4">
              <div class="section-divider recent-divider">
                <span class="section-label">Recent</span>
                <span class="section-hint">继续上次的连接或文件</span>
              </div>
              <div class="recent-list">
                <button
                  v-for="(a, i) in recentAssets"
                  :key="a.id"
                  class="recent-row"
                  :style="{ '--i': i }"
                  @click="connectToAsset(a)"
                >
                  <span class="recent-type">
                    <v-icon size="14">{{ getIcon(a.type) }}</v-icon>
                  </span>
                  <span class="recent-name">{{ a.name }}</span>
                  <span class="recent-meta">{{ a.config.host || a.config.dbType || a.type.toUpperCase() }}</span>
                  <span class="recent-time">{{ shortTimeAgo(a.lastUsedAt) }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        
        <div v-else class="workspace-content">
          <router-view v-slot="{ Component }">
            <transition name="cyber-route" mode="out-in">
              <keep-alive :include="keepAliveIncludes">
                <component :is="keepAliveComponent(Component, route.fullPath)" :key="route.fullPath" />
              </keep-alive>
            </transition>
          </router-view>
        </div>
      </div>
    </div>

    <!-- Status Bar -->
    <div class="statusbar">
      <div class="sb-item cyan">
        <span class="pulse"></span>
        <span>{{ t('common.app') }} v{{ appVersion }}</span>
      </div>
      <div class="sb-item">
        <v-icon size="10">mdi-console</v-icon>
        <span>{{ sshAssets.length }} SSH</span>
      </div>

      <div class="sb-item">
        <v-icon size="10">mdi-database</v-icon>
        <span>{{ dbAssets.length }} DB</span>
      </div>
      <div class="sb-item">
        <v-icon size="10">mdi-docker</v-icon>
        <span>{{ dockerAssets.length }} Docker</span>
      </div>
      <div class="sb-item">
        <v-icon size="10">mdi-file-excel-outline</v-icon>
        <span>{{ excelAssets.length }} Excel</span>
      </div>
      <div class="sb-item">
        <v-icon size="10">mdi-robot-outline</v-icon>
        <span>{{ aiStore.agents.length }} Agent</span>
      </div>
      <div class="sb-right">
      <div class="sb-item">
        <v-icon size="10">mdi-clock</v-icon>
        <span>{{ clockText }}</span>
      </div>
    </div>
    </div>

    <!-- New Connection Dialog -->
    <NewConnectionDialog
      v-model="showNewConnection"
      :initial-type="newConnectionInitialType"
      @submit="handleNewConnection"
    />

    <!-- Settings Dialog -->
    <v-dialog
      v-model="showSettings"
      max-width="960"
      scrollable
      transition="cyber-dialog"
    >
      <div class="settings-dialog cyber-panel">
        <div class="settings-dialog-header">
          <span class="section-number">⚙</span>
          <span class="section-title">{{ t('settings.title') }}</span>
          <v-spacer />
          <button class="action-btn" @click="showSettings = false" :data-tooltip="t('common.close')">
            <v-icon size="16">mdi-close</v-icon>
          </button>
        </div>
        <div class="settings-dialog-body">
          <SettingsView :initial-tab="settingsInitialTab" />
        </div>
      </div>
    </v-dialog>

    <!-- Tab context menu -->
    <ContextMenu
      v-if="tabCtxMenu"
      :x="tabCtxMenu.x"
      :y="tabCtxMenu.y"
      :items="tabCtxItems"
      @close="closeTabContextMenu"
    />

    <!-- 标签栏空隙右键菜单 -->
    <ContextMenu
      v-if="tabBarCtxMenu"
      :x="tabBarCtxMenu.x"
      :y="tabBarCtxMenu.y"
      :items="tabBarCtxItems"
      @close="closeTabBarContextMenu"
    />

    <!-- 标签栏 + 号弹出的资产选择器 -->
    <ContextMenu
      v-if="newTabPicker"
      :x="newTabPicker.x"
      :y="newTabPicker.y"
      :items="newTabPicker.items"
      @close="closeNewTabPicker"
    />

    <!-- 顶部菜单资产选择器(终端/数据库/Docker) -->
    <ContextMenu
      v-if="assetPicker"
      :x="assetPicker.x"
      :y="assetPicker.y"
      :items="assetPicker.items"
      @close="closeAssetPicker"
    />

    <!-- 工作区右键菜单 -->
    <ContextMenu
      v-if="workspaceCtxMenu"
      :x="workspaceCtxMenu.x"
      :y="workspaceCtxMenu.y"
      :items="workspaceCtxItems"
      @close="closeWorkspaceContextMenu"
    />

    <!-- 全局命令面板 (⌘P) -->
    <CommandPalette />

    <!-- 全局传输任务栏(SFTP 上传/下载,可最小化) -->
    <TransferDock />

    <!-- 拖出提示:tab 拖拽全程跟随光标,离开 tab 条死区后高亮(松开即拖出) -->
    <div
      v-if="tabDragState?.dragging"
      class="tab-detach-hint"
      :class="{ armed: tabDragState.detachArmed }"
      :style="{ left: tabDragState.clientX + 14 + 'px', top: tabDragState.clientY + 16 + 'px' }"
    >
      <v-icon size="13">mdi-open-in-new</v-icon>
      <span>{{ tabDragState.detachArmed ? t('layout.detachHint') : t('layout.detachHintIdle') }}</span>
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  height: 100vh;
  display: grid;
  /* P1 §A:布局尺寸 token 化引用,改 token 一处全站生效
   * --layout-titlebar-h / --layout-statusbar-h 来源:cyber.css */
  grid-template-rows: var(--layout-titlebar-h) 1fr var(--layout-statusbar-h);
  grid-template-areas:
    "titlebar"
    "content"
    "statusbar";
  background: var(--bg);
  position: relative;
}

.app-layout::before {
  content: "";
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size: 40px 40px;
  pointer-events: none;
  z-index: 0;
  mask-image: radial-gradient(ellipse 80% 60% at 50% 30%, black 0%, transparent 80%);
}

.titlebar {
  grid-area: titlebar;
  background: var(--chrome-glass-strong);
  border-bottom: 1px solid var(--line-2);
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 14px;
  min-width: 0;
  backdrop-filter: blur(20px);
  position: relative;
  /* 保持高栈,搜索下拉 (z:99) 和用户菜单 (z:100) 才能盖在下方内容区 (z:0/1) 上面 */
  z-index: 100;
}

.titlebar::after {
  content: "";
  position: absolute;
  bottom: -1px;
  left: 20%;
  right: 20%;
  height: 1px;
  background: var(--grad-primary);
  opacity: 0.4;
  filter: blur(0.5px);
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  min-width: 0;
}

.logo-img {
  height: 36px;
  width: auto;
  display: block;
  -webkit-user-drag: none;
  user-select: none;
}

kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 2px 6px;
  background: var(--kbd-bg);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--cyan);
}

.top-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
  align-items: center;
  flex-shrink: 0;
}

.top-action-group {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  background: var(--hover-cyan-faint);
  border-radius: 6px;
}

.top-action-divider {
  width: 1px;
  flex-shrink: 0;
  height: 20px;
  background: var(--line-2);
  margin: 0 6px;
}

@media (max-width: 760px) {
  .titlebar {
    gap: 8px;
    padding: 0 8px;
  }

  .logo-wordmark,
  .top-action-group,
  .user-menu,
  .top-action-divider {
    display: none;
  }
}

.action-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.action-btn:hover {
  background: var(--hover-cyan);
  color: var(--cyan);
  border-color: var(--line-2);
}

.action-btn.primary {
  background: var(--active-cyan);
  color: var(--cyan);
  border: 1px solid var(--status-connecting-border);
  box-shadow: none;
}

.action-btn.primary:hover {
  background: var(--hover-cyan);
  color: var(--cyan);
  border-color: var(--cyan);
  box-shadow: var(--glow-soft);
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--grad-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 11px;
  font-weight: 700;
  box-shadow: var(--glow-pink);
  border: 0;
  padding: 0;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s;
}
.avatar:hover {
  transform: scale(1.05);
  box-shadow: var(--glow-pink);
}

.user-menu {
  position: relative;
}
.user-menu-popup {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  box-shadow: var(--shadow);
  padding: 6px;
  z-index: 100;
  animation: userMenuIn 0.15s ease;
}
@keyframes userMenuIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.user-menu-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
}
.user-menu-header .avatar-large {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--grad-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 14px;
  font-weight: 700;
  box-shadow: var(--glow-pink);
}
.user-menu-header .info { display: flex; flex-direction: column; gap: 2px; }
.user-menu-header .name { font-size: 13px; font-weight: 600; color: var(--text); }
.user-menu-header .email {
  font-size: 11px;
  color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.user-menu-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 0;
}
.user-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--text-2);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
}
.user-menu-item:hover {
  background: var(--hover-cyan-soft);
  color: var(--cyan);
}
.user-menu-item span { flex: 1; }
.user-menu-item kbd {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 1px 5px;
  background: var(--kbd-bg);
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--muted);
}

.menu-item {
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-2);
  font-size: 12px;
  font-family: inherit;
  line-height: 1;
  position: relative;
}

.menu-item:hover:not(:disabled):not(.disabled) {
  background: var(--hover-cyan-soft);
  color: var(--text);
}

.menu-item:focus-visible {
  outline: none;
  border-color: var(--status-connecting-border);
  background: var(--hover-cyan-soft);
}

.menu-item.active {
  color: var(--cyan);
  background: var(--active-cyan);
}

.menu-item.active::after {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: -1px;
  height: 1px;
  background: var(--cyan);
  box-shadow: 0 0 6px var(--cyan);
}

.menu-item.disabled,
.menu-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.tab-strip {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  position: relative; /* TransitionGroup leave 时 tab 变 absolute,需要定位父级 */
}

.tab-strip::-webkit-scrollbar {
  display: none;
}

.tab-strip-wrap {
  display: flex;
  align-items: center;
  gap: 2px;
  /* 标题栏中段:占据 logo 与右侧按钮之间的空间,可收缩,tab 溢出走滚动按钮 */
  flex: 1;
  min-width: 0;
  position: relative;
}

.tab-scroll-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: var(--hover-cyan-soft);
  border: 1px solid var(--line-2);
  cursor: pointer;
  transition: all 0.15s;
  z-index: 2;
}

.tab-scroll-btn:hover {
  color: var(--cyan);
  background: var(--active-cyan);
  border-color: var(--status-connecting-border);
}

.tab-new-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line-2);
  cursor: pointer;
  margin-left: 6px;
  transition: all 0.15s;
}
.tab-new-btn:hover {
  color: var(--cyan);
  background: var(--active-cyan);
  border-color: var(--status-connecting-border);
  box-shadow: var(--glow-soft);
}

.tab {
  padding: 6px 10px 6px 12px;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  position: relative;
  white-space: nowrap;
  max-width: 220px;
  user-select: none;
}

.tab:hover {
  color: var(--text-2);
  background: var(--hover-cyan-faint);
}

.tab.active {
  color: var(--cyan);
  background: linear-gradient(180deg, var(--active-cyan) 0%, transparent 100%);
  border-bottom-color: var(--cyan);
}

/* 拖拽进行中(未武装):轻微透明,提示正在被拖动 */
.tab.dragging {
  opacity: 0.75;
}

/* 拖出武装态:tab 被拖离 tab 条,松开即生成独立窗口 */
.tab.drag-armed {
  opacity: 0.55;
  border-style: dashed;
  outline: 1px dashed var(--focus-cyan);
  outline-offset: -1px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  color: var(--muted);
  opacity: 0.5;
  transition: all 0.15s;
  cursor: pointer;
  flex-shrink: 0;
}

.tab:hover .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: var(--close-hover-bg);
  color: var(--red);
}

.main-content {
  grid-area: content;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  z-index: 1;
}

.sidebar {
  flex-shrink: 0;
  background: var(--chrome-glass-soft);
  border-right: 1px solid var(--line);
  padding: 14px 0;
  overflow: hidden auto;
  backdrop-filter: blur(10px);
  transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

.sidebar.dragging {
  transition: none !important;
}

.sidebar.collapsed {
  /* 折叠态宽度走 inline style (SIDEBAR_COLLAPSED_WIDTH);这里只覆盖可能的默认 width */
  width: 60px;
}

.sidebar-section {
  margin-bottom: 18px;
}

.sidebar-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 14px;
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 700;
}

.sidebar-head .count {
  margin-left: auto;
  color: var(--cyan);
  font-weight: 500;
  font-family: 'JetBrains Mono', monospace;
}

.tree-item {
  padding: 5px 14px 5px 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  border-left: 2px solid transparent;
}

.tree-item:hover {
  background: var(--hover-cyan-faint);
  color: var(--text);
}

.tree-item.active {
  background: linear-gradient(90deg, var(--active-cyan) 0%, transparent 100%);
  color: var(--cyan);
  border-left-color: var(--cyan);
  text-shadow: 0 0 10px var(--focus-cyan);
}

.tree-item .status {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-left: auto;
}

.tree-item .status.online {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
  animation: pulse 2s infinite;
}

.tree-item .status.offline {
  background: var(--muted);
}

.workspace {
  flex: 1;
  min-width: 0;
  background: transparent;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}

.workspace-content {
  flex: 1;
  overflow: auto;
}

.statusbar {
  grid-area: statusbar;
  background: var(--chrome-glass-strong);
  border-top: 1px solid var(--line-2);
  padding: 0 16px;
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 10px;
  color: var(--muted);
  backdrop-filter: blur(10px);
  font-family: 'JetBrains Mono', monospace;
  /* 保持栈底,避免覆盖 v-dialog 等弹层 */
  z-index: 0;
  position: relative;
}

.sb-item {
  display: flex;
  align-items: center;
  gap: 5px;
  transition: color 0.2s;
  cursor: default;
}

.sb-item.cyan {
  color: var(--cyan);
}

.sb-item .pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cyan);
  box-shadow: 0 0 8px var(--cyan);
  animation: pulse 1.5s infinite;
}

.sb-right {
  margin-left: auto;
  display: flex;
  gap: 16px;
}

@media (max-width: 900px) {
  .logo-wordmark,
  .statusbar .sb-item:nth-child(n + 4) {
    display: none;
  }

  .top-action-group {
    gap: 4px;
  }
}

@media (max-width: 640px) {
  .titlebar {
    padding: 0 8px;
    gap: 8px;
  }

  .user-menu,
  .statusbar .sb-item:nth-child(n + 3) {
    display: none;
  }

  .sidebar:not(.collapsed) {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 30;
    box-shadow: var(--shadow);
  }
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}

/* ====== Settings Dialog ====== */
.settings-dialog {
  display: flex;
  flex-direction: column;
  height: 90vh;
  max-height: 840px;
  border-radius: 16px;
  overflow: hidden;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
}

.settings-dialog-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
  background: var(--panel-solid-2);
}

.settings-dialog-header .section-number {
  font-family: 'Orbitron', sans-serif;
  font-size: 14px;
  font-weight: 700;
  color: var(--cyan);
  text-shadow: 0 0 8px var(--cyan);
}

.settings-dialog-header .section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}

.settings-dialog-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}
</style>
