/**
 * StarHub 功能页清单:侧栏导航条目 ↔ embed 路由的唯一事实表(P1 定义,P3 改段路由)。
 * route 是 StarHub embed 入口(`/starhub/index.html?embed=1&route=...`)的直达
 * 路径;P3 起统一用「段路由」(不带资产 id,如 /ssh),embed 侧守卫负责解析:
 * 有该类型资产 → 重定向到带 instanceId 的功能路由;无资产 → 停在段空态页,
 * 顶部资产条(EmbedAssetBar)给出「去设置添加」入口(postMessage 回本壳切设置)。
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

/** 一个功能页条目:侧栏展示 + iframe src 的路由参数。 */
export interface StarHubSection {
  /** 稳定 key,同时是 store 里 active 的取值。 */
  key: string
  /** 侧栏条目的中文文案。 */
  label: string
  /** embed 入口的 route 参数(站内绝对路径,段路由不带资产 id)。 */
  route: string
  /** 侧栏图标(ui-primitives 现成字形)。 */
  Icon: ComponentType<IconProps>
}

/** 导航条目清单(展示顺序即数组顺序)。 */
export const STARHUB_SECTIONS: readonly StarHubSection[] = [
  { key: 'terminal', label: '终端', route: '/ssh', Icon: IconCodeOutline16 },
  { key: 'database', label: '数据库', route: '/db/mysql', Icon: IconDataOutline16 },
  { key: 'redis', label: 'Redis', route: '/db/redis', Icon: IconChecklistOutline14 },
  { key: 'elasticsearch', label: 'Elasticsearch', route: '/db/elasticsearch', Icon: IconSearchOutline16 },
  { key: 'docker', label: 'Docker', route: '/docker', Icon: IconArchiveOutline20 },
  { key: 'broker', label: 'Broker', route: '/broker', Icon: IconBranchOutline16 },
  { key: 'excel', label: 'Excel', route: '/excel', Icon: IconListPenOutline16 },
  { key: 'settings', label: '设置', route: '/settings', Icon: IconSettingsOutline16 },
]

/**
 * 组装功能页 iframe 的 src(host-static 把 StarHub embed dist 托管在 /starhub/)。
 * @param section - 目标功能页条目。
 * @returns embed 入口 URL(站内路径)。
 */
export function sectionEmbedUrl(section: StarHubSection): string {
  return `/starhub/index.html?embed=1&route=${encodeURIComponent(section.route)}`
}
