import type { TabType } from '@/stores/app'

/**
 * 标签页"拖出为独立窗口"的窗口侧协议。
 *
 * 主窗口在创建 WebviewWindow 时把还原工作区所需的最小信息
 * 编进 URL query(`index.html?detach=1&route=/ssh/<instanceId>&title=...&type=ssh`),
 * 新窗口启动时解析一次(窗口生命周期内不变),CyberLayout 据此渲染
 * 精简外壳(无 sidebar / tab 条 / 状态栏)并直接 router.replace 到该路由。
 */
export interface DetachedInfo {
  /** 要直接挂载的工作区路由(含 tab instanceId) */
  route: string
  /** tab 标题(显示在独立窗口标题栏) */
  title: string
  /** tab 类型(标题栏图标) */
  type: TabType
  /** 资产 id(送回主窗口时重建 Tab 用) */
  assetId: string
  /** tab instanceId(route 最后一段,送回主窗口时重建 Tab 用) */
  instanceId: string
}

let cached: DetachedInfo | null | undefined

/** 当前窗口是否为从主窗口拖出的独立工作区窗口 */
export function getDetachedInfo(): DetachedInfo | null {
  if (cached !== undefined) return cached
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('detach') !== '1') {
      cached = null
      return cached
    }
    const route = params.get('route') || '/'
    cached = {
      route,
      title: params.get('title') || 'StarHub',
      type: (params.get('type') as TabType) || 'ssh',
      assetId: params.get('assetId') || '',
      instanceId: route.slice(route.lastIndexOf('/') + 1),
    }
  } catch {
    cached = null
  }
  return cached
}

/** instanceId 含 `__` 等字符,统一消毒成窗口 label 安全字符 */
export function detachedLabelFor(tabId: string): string {
  return `detach-${tabId.replace(/[^a-zA-Z0-9]/g, '-')}`
}

export function buildDetachedUrl(route: string, title: string, type: TabType, assetId: string): string {
  const params = new URLSearchParams({ detach: '1', route, title, type, assetId })
  return `index.html?${params.toString()}`
}

/**
 * 独立窗口 → 主窗口的"把 tab 送回来"事件。
 * payload: { id, assetId, title, type }(即完整 Tab)
 */
export const TAB_REATTACH_EVENT = 'starhub://tab-reattach'

/**
 * 主窗口内部的本地事件(CustomEvent,不跨窗口):
 * detach 前广播给缓存的 keep-alive 组件实例,
 * 让它们停止消费后端会话数据(但不断开后端 session,留给新窗口附加)。
 */
export const LOCAL_TAB_DETACH_EVENT = 'starhub:tab-detach'
