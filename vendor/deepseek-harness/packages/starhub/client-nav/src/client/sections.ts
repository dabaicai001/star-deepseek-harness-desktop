/**
 * StarHub 功能导航事实表:三层结构「工具大类 → 子类 → 资产路由」(P1 方案)。
 *
 * 侧栏展示「工具」大类行(即分组头,可展开),下挂子类(终端 / 数据库 /
 * Docker);点子类 → 右侧工具工作区列显示该类型的资产(连接)列表;点资产
 * 行 → 新开独立窗口加载该实例的操作页(embed 入口
 * `/starhub/index.html?embed=1&route=...`,不再以整幅 overlay 盖住主壳)。
 * 子类只定义分组/图标/资产匹配;实例路由前缀一律按资产类型经
 * `routePrefixForAsset` 派生(数据库子类混有多种库,不能共用子类前缀)。
 * Excel 已不在导航里(功能退役出侧栏);设置直接融入 dsh 底部设置面板
 * (StarHub 分组,壳内 React tab),连接管理为壳内小对话框。
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

/** 资产 → embed 功能路由名(与 src/utils/assetRouting.ts 的 routeNameForAsset 同构;只需 type + config)。 */
export function routeNameForAsset(asset: { type: string; config: Record<string, unknown> }): string {
  if (asset.type === 'ssh') return 'ssh-terminal'
  if (asset.type === 'docker') return 'docker'
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
}

/** 渲染模式:迁移事实表记录(壳内 native 组件 vs embed iframe)。 */
export type StarHubRenderMode = 'iframe' | 'native'

/**
 * 已壳内 React 化的功能路由集合(迁移手册 §3.3 事实表规则:每迁一页,只改
 * 这一行/这一个集合——加路由名 = 切 native,删 = 一行回退 iframe)。
 * 注:当前实例操作页一律经 openNewPage 开独立窗口(embed URL),native
 * 集合暂不参与渲染分派,仅作迁移进度事实表保留(含 BrokerView 及其测试)。
 */
export const NATIVE_ROUTE_NAMES: ReadonlySet<string> = new Set(['db-broker', 'ssh-terminal'])

/**
 * 资产 → 渲染模式:路由在 NATIVE_ROUTE_NAMES 里走壳内组件,否则 iframe。
 * @param asset - 目标资产(只需 type + config 判定路由)。
 * @returns 该资产实例操作页的渲染模式。
 */
export function renderModeForAsset(asset: { type: string; config: Record<string, unknown> }): StarHubRenderMode {
  return NATIVE_ROUTE_NAMES.has(routeNameForAsset(asset)) ? 'native' : 'iframe'
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

/**
 * 资产副标题(user@host 之类,取最常用字段;没有就不显示)。工作区资产行、
 * `@` 资产 source 的候选/引用序列化共用这一个事实表。
 * @param asset - 资产(只需 config 判定)。
 * @returns 副标题文本;无可用字段时为空串。
 */
export function assetSubtitle(asset: { config: Record<string, unknown> }): string {
  const c = asset.config
  const host = typeof c.host === 'string' ? c.host : ''
  const username = typeof c.username === 'string' ? c.username : ''
  if (host !== '' && username !== '') return `${username}@${host}`
  if (host !== '') return host
  return typeof c.database === 'string' ? c.database : ''
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
 * 组装实例操作页 URL(host-static 托管 StarHub embed dist 在 /starhub/)。
 * instanceId 由打开动作生成一次(`<assetId>__<timestamp>`,与 src/utils/tabId.ts
 * 同构,embed 侧经 parseInstanceId 反解资产 id)并随选择桥传递——不得在渲染期
 * 重新生成,否则任何重渲染都会改地址重载页面、丢终端会话。
 * @param routePrefix - 段路由前缀(按 routePrefixForAsset 派生)。
 * @param instanceId - 打开动作生成的实例 id。
 * @returns embed 入口 URL(站内路径)。
 */
export function assetInstanceUrl(routePrefix: string, instanceId: string): string {
  return `/starhub/index.html?embed=1&route=${encodeURIComponent(`${routePrefix}/${instanceId}`)}`
}
