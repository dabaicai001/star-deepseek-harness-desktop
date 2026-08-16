/**
 * StarHub 功能导航事实表:三层结构「工具大类 → 子类 → 资产路由」(P1 方案)。
 *
 * 侧栏展示「工具」大类(可展开),下挂子类(终端 / 数据库 / Docker);
 * 点子类 → 右侧工具工作区列显示该类型的资产(连接)列表;点资产行 →
 * 弹出该实例的操作页(embed iframe,`/starhub/index.html?embed=1&route=...`)。
 * route 前缀与资产匹配规则在子类上定义,实例路由由 `assetInstanceRoute` 派生。
 */
import {
  IconArchiveOutline20,
  IconBranchOutline16,
  IconChecklistOutline14,
  IconCodeOutline16,
  IconDataOutline16,
  IconListPenOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
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
 * 一个子类:侧栏子行 + 右侧资产列表过滤 + 实例路由前缀。
 * 资产匹配复用 `routeNameForAsset` 的路由名映射(asset.type + config.dbType)。
 */
export interface StarHubSubcategory {
  /** 稳定 key(store 里 activeSubcategory 的取值)。 */
  key: string
  /** 侧栏子行文案。 */
  label: string
  /** embed 入口的段路由前缀(不带资产 id),如 /ssh、/db/mysql。 */
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

/** 子类清单(展示顺序即数组顺序)。数据库合并 MySQL / PG / CH / Redis / ES 为一个子类。 */
export const STARHUB_SUBCATEGORIES: readonly StarHubSubcategory[] = [
  {
    key: 'terminal',
    label: '终端',
    routePrefix: '/ssh',
    Icon: IconCodeOutline16,
    matches: (a) => routeNameForAsset(a) === 'ssh-terminal',
  },
  {
    key: 'database',
    label: '数据库',
    routePrefix: '/db/mysql',
    Icon: IconDataOutline16,
    matches: (a) => {
      const name = routeNameForAsset(a)
      return name === 'db-mysql' || name === 'db-postgresql' || name === 'db-clickhouse'
        || name === 'db-redis' || name === 'db-elasticsearch' || name === 'db-broker'
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

/** 遗留:旧扁平条目清单(仅设置等非资产型页面保留,供 overlay 直开)。 */
export const STARHUB_SECTIONS: readonly { key: string; label: string; route: string; Icon: ComponentType<IconProps> }[] = [
  { key: 'broker', label: 'Broker', route: '/broker', Icon: IconBranchOutline16 },
  { key: 'redis', label: 'Redis', route: '/db/redis', Icon: IconChecklistOutline14 },
  { key: 'elasticsearch', label: 'Elasticsearch', route: '/db/elasticsearch', Icon: IconSearchOutline16 },
  { key: 'excel', label: 'Excel', route: '/excel', Icon: IconListPenOutline16 },
  { key: 'settings', label: '设置', route: '/settings', Icon: IconSettingsOutline16 },
]

/**
 * 组装旧扁平功能页 iframe 的 src(host-static 托管 StarHub embed dist 在 /starhub/)。
 * @param section - 旧扁平条目(设置等非资产型页面)。
 * @returns embed 入口 URL(站内路径)。
 */
export function sectionEmbedUrl(section: { route: string }): string {
  return `/starhub/index.html?embed=1&route=${encodeURIComponent(section.route)}`
}

/**
 * 组装实例操作页 iframe 的 src(host-static 托管 StarHub embed dist 在 /starhub/)。
 * 实例路由用 instanceId(`<assetId>__<timestamp>`,与 src/utils/tabId.ts 同构),
 * embed 侧经 parseInstanceId 反解资产 id。
 * @param routePrefix - 子类段路由前缀(如 /ssh)。
 * @param assetId - 目标资产 id。
 * @returns embed 入口 URL(站内路径)。
 */
export function assetInstanceUrl(routePrefix: string, assetId: string): string {
  const instanceId = `${assetId}__${Date.now()}`
  return `/starhub/index.html?embed=1&route=${encodeURIComponent(`${routePrefix}/${instanceId}`)}`
}
