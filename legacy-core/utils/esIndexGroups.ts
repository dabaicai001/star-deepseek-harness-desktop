/**
 * ES 索引分组:业务 / metricbeat-* / 系统(默认隐藏)。
 * 纯函数,objectTree store 与 EsOverview 共用。
 */
export interface EsIndexLike {
  name: string
  docsCount?: number
}

export type EsGroupKey = 'business' | 'metricbeat' | 'system'

export interface EsIndexGroup<T extends EsIndexLike> {
  key: EsGroupKey
  label: string
  indices: T[]
  /** 默认隐藏(系统索引),树上展示为 "N (隐藏)" 且默认折叠 */
  hidden: boolean
}

export function groupEsIndices<T extends EsIndexLike>(indices: T[]): EsIndexGroup<T>[] {
  const business: T[] = []
  const metricbeat: T[] = []
  const system: T[] = []
  for (const idx of indices) {
    if (idx.name.startsWith('.')) system.push(idx)
    else if (idx.name.startsWith('metricbeat')) metricbeat.push(idx)
    else business.push(idx)
  }
  return [
    { key: 'business' as const, label: '业务索引', indices: business, hidden: false },
    { key: 'metricbeat' as const, label: 'metricbeat-*', indices: metricbeat, hidden: false },
    { key: 'system' as const, label: '系统索引', indices: system, hidden: true }
  ].filter(g => g.indices.length > 0)
}
