/**
 * Tab instance id 工具
 *
 * 设计:同一资产可以开多个 tab(同资产多 session),所以 tab 需要一个
 * "实例 id"和"资产 id"两个概念。Tab.id = instanceId,Tab.assetId = assetId。
 *
 * 路由 `ssh/:id` / `db/...` 现在用 instanceId,SshTerminal 等组件拿到 props.id 后
 * 再用本文件工具反解出 assetId 去查找资产配置。
 *
 * 格式:instanceId = `${assetId}__${suffix}`
 *  - 用双下划线 `__` 分隔,避免和 UUID 内部的 `-` 冲突
 *  - suffix = 时间戳(连点多次同资产会用不同时间戳得到不同 id)
 *  - parseInstanceId 不关心 suffix 内容,只看 `__` 之前
 */

/** Tab 标题后缀(显示在 tab title 上,例如 "TEST #2"),null 表示不显示 */
export interface ParsedInstanceId {
  /** 资产 id(用于查找资产配置) */
  assetId: string
  /** 用于去重/排序的时间戳;无 suffix 时为 null */
  suffix: string | null
}

export const TAB_ID_SEPARATOR = '__'

/** 给定资产 id,生成一个 instanceId(带时间戳后缀,保证同资产多次调用得到不同 id) */
export function generateInstanceId(assetId: string): string {
  return `${assetId}${TAB_ID_SEPARATOR}${Date.now()}`
}

/** 从 instanceId 解析出 assetId + suffix;解析失败时回退到原值(整段当 assetId) */
export function parseInstanceId(id: string | null | undefined): ParsedInstanceId {
  if (!id) return { assetId: '', suffix: null }
  const idx = id.indexOf(TAB_ID_SEPARATOR)
  if (idx <= 0 || idx === id.length - 1) {
    // 没有 separator,或 separator 在末尾 → 整段当 assetId
    return { assetId: id, suffix: null }
  }
  return {
    assetId: id.slice(0, idx),
    suffix: id.slice(idx + TAB_ID_SEPARATOR.length)
  }
}

/**
 * 计算 tab 的显示标题:同一资产有多个 tab 时,第二个开始加 "#2" "#3" 后缀。
 *  - only:只有一个 tab,保持原标题
 *  - 多 tab:按 instanceId 时间戳升序,从 #2 开始递增
 */
export function withTabIndexSuffix(
  baseTitle: string,
  instanceId: string,
  allInstanceIds: string[]
): string {
  const sameAsset = allInstanceIds
    .map(parseInstanceId)
    .filter(p => p.assetId === parseInstanceId(instanceId).assetId)
    .sort((a, b) => (a.suffix ?? '').localeCompare(b.suffix ?? ''))
  if (sameAsset.length <= 1) return baseTitle
  const idx = sameAsset.findIndex(p => p.suffix === parseInstanceId(instanceId).suffix)
  if (idx <= 0) return baseTitle
  return `${baseTitle} #${idx + 1}`
}
