/**
 * dsh 壳 iframe 内嵌模式的窗口侧协议(P1 主壳融合)。
 *
 * dsh 侧 client-nav 插件把功能页嵌进 `/starhub/index.html?embed=1&route=<path>`
 * 的同源 iframe(host-static 插件托管 dist,base `/starhub/`)。
 * embed=1 时 CyberLayout 渲染去壳外壳(无 titlebar / tab 条 / 侧栏 / 状态栏,
 * 不套 keep-alive、不进 appStore.tabs),并直接 router.replace 到 route。
 * P4a 起 embed 是唯一形态(旧外壳与 windowDetach 拖出窗口已退役);
 * 参数在 iframe 生命周期内只解析一次。
 */

import type { Asset } from '@/types/asset'
import { routeNameForAsset } from '@/utils/assetRouting'
import { generateInstanceId } from '@/utils/tabId'

let cachedEmbed: boolean | undefined
let cachedRoute: string | null | undefined

/** 当前页面是否运行在 dsh 壳的 embed iframe 内 */
export function isEmbedMode(): boolean {
  if (cachedEmbed !== undefined) return cachedEmbed
  try {
    cachedEmbed = new URLSearchParams(window.location.search).get('embed') === '1'
  } catch {
    cachedEmbed = false
  }
  return cachedEmbed
}

/** embed 入口指定的直达路由(如 /ssh);未指定或非 embed 时为 null */
export function embedRoute(): string | null {
  if (cachedRoute !== undefined) return cachedRoute
  cachedRoute = null
  if (isEmbedMode()) {
    try {
      const route = new URLSearchParams(window.location.search).get('route')
      // 只接受站内绝对路径,挡掉协议相对 / 外站注入
      if (route && route.startsWith('/') && !route.startsWith('//')) cachedRoute = route
    } catch {
      cachedRoute = null
    }
  }
  return cachedRoute
}

// ====== embed 段路由表(P3 资产选择骨架)======
// client-nav 的导航条目指向「段路由」(不带资产 id,如 /ssh);embed 侧负责
// 解析:有该类型资产 → 重定向到带 instanceId 的功能路由;无资产 → 停在段
// 路由的空态页。key 与 client-nav sections.ts 的条目一一对应。

export interface EmbedSectionDef {
  /** 稳定 key,与 client-nav sections.ts 的条目一致 */
  key: string
  /** 段路由(不带资产 id),如 /ssh */
  pathPrefix: string
  /** 带 :id 的功能路由名;null = 无资产型页面(如设置,不挂资产条) */
  routeName: string | null
  /** 资产条上的段图标(mdi) */
  icon: string
}

/** embed 功能页清单(与 client-nav sections.ts 保持同序) */
export const EMBED_SECTIONS: readonly EmbedSectionDef[] = [
  { key: 'terminal', pathPrefix: '/ssh', routeName: 'ssh-terminal', icon: 'mdi-console' },
  { key: 'database', pathPrefix: '/db/mysql', routeName: 'db-mysql', icon: 'mdi-database' },
  { key: 'redis', pathPrefix: '/db/redis', routeName: 'db-redis', icon: 'mdi-database-sync' },
  { key: 'elasticsearch', pathPrefix: '/db/elasticsearch', routeName: 'db-elasticsearch', icon: 'mdi-magnify' },
  { key: 'clickhouse', pathPrefix: '/db/clickhouse', routeName: 'db-clickhouse', icon: 'mdi-database-clock' },
  { key: 'postgresql', pathPrefix: '/db/postgresql', routeName: 'db-postgresql', icon: 'mdi-database-outline' },
  { key: 'docker', pathPrefix: '/docker', routeName: 'docker', icon: 'mdi-docker' },
  { key: 'broker', pathPrefix: '/broker', routeName: 'db-broker', icon: 'mdi-graph-outline' },
  { key: 'excel', pathPrefix: '/excel', routeName: 'excel', icon: 'mdi-file-excel-outline' },
  { key: 'settings', pathPrefix: '/settings', routeName: null, icon: 'mdi-cog-outline' },
]

/** 资产是否属于该 embed 段(复用 routeNameForAsset 这一事实表) */
export function embedSectionMatchAsset(section: EmbedSectionDef, asset: Asset): boolean {
  return section.routeName !== null && routeNameForAsset(asset) === section.routeName
}

/**
 * 解析 embed 入口路由:段路由(无 id)→ 该类型最近使用资产的功能路由
 * (`<prefix>/<instanceId>`);无资产 → 原样返回段路由(落到空态页)。
 * 带 id 的完整路由与未知路径原样返回。
 */
export function resolveEmbedTarget(target: string, assets: Asset[]): string {
  const section = EMBED_SECTIONS.find(s => s.routeName !== null && s.pathPrefix === target)
  if (!section) return target
  const candidates = assets
    .filter(a => embedSectionMatchAsset(section, a))
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  if (candidates.length === 0) return target
  return `${section.pathPrefix}/${generateInstanceId(candidates[0].id)}`
}

/** 当前路由对应的 embed 段(功能页按 routeName,段空态页按 route.meta.embedSection) */
export function embedSectionForRoute(route: { name?: unknown; meta?: Record<string, unknown> }): EmbedSectionDef | null {
  const metaKey = route.meta?.embedSection
  if (typeof metaKey === 'string') {
    return EMBED_SECTIONS.find(s => s.key === metaKey) ?? null
  }
  const name = typeof route.name === 'string' ? route.name : ''
  return EMBED_SECTIONS.find(s => s.routeName !== null && s.routeName === name) ?? null
}

/** 请求 dsh 壳(client-nav overlay)打开另一个功能页(如设置);非 embed 或无父帧时静默 */
export function postEmbedOpenSection(key: string): void {
  if (!isEmbedMode() || window.parent === window) return
  window.parent.postMessage({ type: 'starhub-embed-open-section', key }, window.location.origin)
}
