/**
 * 从 asset 列表算仪表盘需要的指标。
 * 全部基于真实 asset store,无 mock。
 */
import type { Asset, AssetType } from '@/types/asset'

export interface TypeBucket {
  type: AssetType
  label: string
  count: number
  color: string
}

export interface DailyBucket {
  date: Date
  /** 0-23 数字日期,easy key */
  day: number
  /** YYYY-MM-DD */
  label: string
  count: number
}

export interface TagBucket {
  tag: string
  count: number
}

const TYPE_META: Record<AssetType, { label: string; color: string }> = {
  ssh: { label: 'SSH', color: '#00f0ff' },
  db: { label: 'Database', color: '#b56bff' },
  docker: { label: 'Docker', color: '#4ade80' },
}

/** 总数 + 按类型分桶 */
export function summarizeByType(assets: Asset[]): {
  total: number
  buckets: TypeBucket[]
} {
  const counts: Record<AssetType, number> = { ssh: 0, db: 0, docker: 0 }
  for (const a of assets) counts[a.type]++
  const buckets = (Object.keys(counts) as AssetType[]).map(type => ({
    type,
    label: TYPE_META[type].label,
    color: TYPE_META[type].color,
    count: counts[type],
  }))
  return { total: assets.length, buckets }
}

/** 收藏夹分组 */
export function summarizeFavorites(assets: Asset[]) {
  const favs = assets.filter(a => a.favorite)
  return {
    total: favs.length,
    items: favs,
  }
}

/**
 * 最近 7 天每天的使用次数(按 lastUsedAt 落桶)
 * 包含今天(右端),共 7 个桶,按时间正序
 */
export function summarizeLast7Days(assets: Asset[]): DailyBucket[] {
  const now = new Date()
  const buckets: DailyBucket[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const day = d.getDate()
    const label = `${d.getMonth() + 1}/${d.getDate()}`
    buckets.push({ date: d, day, label, count: 0 })
  }
  for (const a of assets) {
    if (!a.lastUsedAt) continue
    const t = new Date(a.lastUsedAt)
    t.setHours(0, 0, 0, 0)
    const diffMs = now.getTime() - t.getTime()
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffDays < 0 || diffDays > 6) continue
    const idx = 6 - diffDays
    if (buckets[idx]) buckets[idx].count++
  }
  return buckets
}

/**
 * 标签云(从所有资产的 tags 数组聚合)
 */
export function summarizeTags(assets: Asset[]): TagBucket[] {
  const map = new Map<string, number>()
  for (const a of assets) {
    for (const t of a.tags || []) {
      map.set(t, (map.get(t) || 0) + 1)
    }
  }
  return Array.from(map.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
}

/** 数据库类型分桶(更细的统计) */
export function summarizeByDbType(assets: Asset[]): {
  type: string
  count: number
  color: string
}[] {
  const counts: Record<string, number> = {}
  for (const a of assets) {
    if (a.type !== 'db') continue
    const t = a.config.dbType || 'unknown'
    counts[t] = (counts[t] || 0) + 1
  }
  const palette: Record<string, string> = {
    mysql: '#b56bff',
    postgresql: '#4dd9ff',
    redis: '#ff4d6d',
    sqlite: '#4ade80',
    clickhouse: '#facc15',
    mssql: '#ff8a3d',
    oracle: '#ff3d9a',
    unknown: '#5a6a96',
  }
  return Object.entries(counts).map(([type, count]) => ({
    type,
    count,
    color: palette[type] || palette.unknown,
  }))
}
