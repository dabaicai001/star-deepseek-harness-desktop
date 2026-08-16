/**
 * StarHub 功能导航事实表:三层结构「工具大类 → 子类 → 资产路由」(P1 方案)。
 *
 * 侧栏展示「工具」大类行(即分组头,可展开),下挂子类(终端 / 数据库 /
 * Docker);点子类 → 右侧工具工作区列显示该类型的资产(连接)列表;点资产
 * 行 → 弹出该实例的操作页(embed iframe,`/starhub/index.html?embed=1&route=...`)。
 * 子类只定义分组/图标/资产匹配;实例路由前缀一律按资产类型经
 * `routePrefixForAsset` 派生(数据库子类混有多种库,不能共用子类前缀)。
 * Excel 已不在导航里(功能退役出侧栏);设置经 `settingsEmbedUrl` 进入
 * dsh 底部设置面板(StarHub 分区)与连接管理 overlay。
 */
import {
  IconArchiveOutline20,
  IconCodeOutline16,
  IconDataOutline16,
  type IconProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

/** 资产序列化形态(与 src-tauri/src/commands/asset.rs 一致,供匹配用)。 */
export interface StarHubAsset {
  id: string
  type: string
  name: string
  config: Record<string, unknown>
}

/**
 * 一个子类:侧栏子行 + 右侧资产列表过滤 + 缺省段路由前缀。
 * 资产匹配复用 `routeNameForAsset` 的路由名映射(asset.type + config.dbType)。
 */
export interface StarHubSubcategory {
  /** 稳定 key(store 里 activeSubcategory 的取值)。 */
  key: string
  /** 侧栏子行文案。 */
  label: string
  /** 缺省段路由前缀(无资产空态与 routePrefixForAsset 未命中时的回退)。 */
  routePrefix: string
  /** 侧栏子行图标(ui-primitives 现成字形)。 */
  Icon: ComponentType<IconProps>
  /** 资产是否属于该子类(复用 routeNameForAsset 语义)。 */
  matches: (asset: StarHubAsset) => boolean
}

/** 资产 → embed 功能路由名(与 src/utils/assetRouting.ts 的 routeNameForAsset 同构)。 */
export function routeNameForAsset(asset: StarHubAsset): string {
  if (asset.type === 'ssh') return 'ssh-terminal'
  if (asset.type === 'docker') return 'docker'
  if (asset.type === 'excel') return 'excel'
  if (asset.type === 'local') return 'local'
  const dbType = typeof asset.config.dbType === 'string' ? asset.config.dbType : 'mysql'
  if (dbType === 'redis') return 'db-redis'
  if (dbType === 'elasticsearch') return 'db-elasticsearch'
  if (dbType === 'clickhouse') return 'db-clickhouse'
  if (dbType === 'postgresql') return 'db-postgresql'
  if (dbType === 'kafka' || dbType === 'nsq') return 'db-broker'
  return 'db-mysql'
}

/** 功能路由名 → embed 段路由前缀(与 src/router/index.ts 的 :id 路由一致)。 */
export const ROUTE_NAME_PREFIX: Readonly<Record<string, string>> = {
  'ssh-terminal': '/ssh',
  'db-mysql': '/db/mysql',
  'db-postgresql': '/db/postgresql',
  'db-clickhouse': '/db/clickhouse',
  'db-redis': '/db/redis',
  'db-elasticsearch': '/db/elasticsearch',
  'db-broker': '/broker',
  docker: '/docker',
  excel: '/excel',
}

/**
 * 资产 → embed 段路由前缀。实例操作页必须按资产类型派生前缀:
 * 数据库子类下 MySQL / PG / CH / Redis / ES 各有独立功能路由(不同视图),
 * 用子类前缀会把 Redis/ES 资产错路由进 MySQL 工作台。
 * @param asset - 目标资产。
 * @returns 段路由前缀;无功能路由的类型(如 local)返回 null。
 */
export function routePrefixForAsset(asset: StarHubAsset): string | null {
  return ROUTE_NAME_PREFIX[routeNameForAsset(asset)] ?? null
}

/** 子类清单(展示顺序即数组顺序)。终端含 SSH/SFTP/Broker,数据库合并 MySQL / PG / CH / Redis / ES(方案 2.1)。 */
export const STARHUB_SUBCATEGORIES: readonly StarHubSubcategory[] = [
  {
    key: 'terminal',
    label: '终端',
    routePrefix: '/ssh',
    Icon: IconCodeOutline16,
    matches: (a) => {
      const name = routeNameForAsset(a)
      return name === 'ssh-terminal' || name === 'db-broker'
    },
  },
  {
    key: 'database',
    label: '数据库',
    routePrefix: '/db/mysql',
    Icon: IconDataOutline16,
    matches: (a) => {
      const name = routeNameForAsset(a)
      return name === 'db-mysql' || name === 'db-postgresql' || name === 'db-clickhouse'
        || name === 'db-redis' || name === 'db-elasticsearch'
    },
  },
  {
    key: 'docker',
    label: 'Docker',
    routePrefix: '/docker',
    Icon: IconArchiveOutline20,
    matches: (a) => routeNameForAsset(a) === 'docker',
  },
]

/**
 * StarHub 设置页的 embed 入口 URL(host-static 托管 embed dist 在 /starhub/)。
 * 设置页支持经 query 过滤可见 tab 子集与初始 tab(StarHub 侧
 * SettingsView.visibleTabs / router query props):
 * - 连接管理 overlay(侧栏工具区「新建连接」):只挂资产 tab;
 * - dsh 设置面板的 StarHub 分区:去掉资产/外观,落地 AI tab,且隐藏
 *   页面自带的关闭钮(chrome=inline,关闭由 dsh 对话框负责)。
 * @param tabs - 可见 tab 子集(SettingsView 的 TabKey)。
 * @param tab - 初始 tab。
 * @param chrome - 'inline' 隐藏 embed 页关闭钮。
 * @returns embed 入口 URL(站内路径)。
 */
export function settingsEmbedUrl(tabs: readonly string[], tab: string, chrome?: 'inline'): string {
  const params = new URLSearchParams()
  if (tabs.length > 0) params.set('tabs', tabs.join(','))
  params.set('tab', tab)
  if (chrome !== undefined) params.set('chrome', chrome)
  return `/starhub/index.html?embed=1&route=${encodeURIComponent(`/settings?${params.toString()}`)}`
}

/** dsh 设置面板 StarHub 分区的可见 tab(去掉资产/外观:资产经侧栏工具区管理,外观由 dsh 主题设置负责)。 */
export const SETTINGS_SECTION_TABS = ['general', 'ai', 'plugins', 'audit', 'alert', 'about'] as const

/** 连接管理 overlay 的可见 tab(只挂资产管理)。 */
export const CONNECTION_MANAGER_TABS = ['assets'] as const

/**
 * 组装实例操作页 iframe 的 src(host-static 托管 StarHub embed dist 在 /starhub/)。
 * instanceId 由打开动作生成一次(`<assetId>__<timestamp>`,与 src/utils/tabId.ts
 * 同构,embed 侧经 parseInstanceId 反解资产 id)并随选择桥传递——不得在渲染期
 * 重新生成,否则任何重渲染都会改 src 重载 iframe、丢终端会话。
 * @param routePrefix - 段路由前缀(按 routePrefixForAsset 派生)。
 * @param instanceId - 打开动作生成的实例 id。
 * @returns embed 入口 URL(站内路径)。
 */
export function assetInstanceUrl(routePrefix: string, instanceId: string): string {
  return `/starhub/index.html?embed=1&route=${encodeURIComponent(`${routePrefix}/${instanceId}`)}`
}
