/**
 * AI 设置持久化桥(React 壳内版,settings AI tab 用)。
 *
 * 读写与 Vue 版 `src/stores/ai.ts` 同一份 localStorage(pinia 持久化
 * key `ai-v2`,paths 含 settings):本模块只碰 AI tab 未随 dsh 接管而保留
 * 的记忆与上下文区块,其余字段原样保留。命令白名单已随「统一走
 * deepseek-harness 权限体系」移除,不再读也不再写。
 */

/** localStorage key(与 aiStore 的 persist key 同名,用户数据无缝)。 */
export const AI_STORAGE_KEY = 'ai-v2'

/** AI 设置(只声明 AI tab 保留区块相关字段,其余原样透传)。 */
export interface AiSettings {
  memoryStoreToolOutputs: boolean
  memoryEnabled: boolean
  memoryWriteNeedsConfirm: boolean
  memoryAutoReview: boolean
}

/** 默认值(与 aiStore settings 初始值一致)。 */
function defaultAiSettings(): AiSettings {
  return {
    memoryStoreToolOutputs: false,
    memoryEnabled: true,
    memoryWriteNeedsConfirm: false,
    memoryAutoReview: true,
  }
}

/**
 * 归一化一次持久化 settings(与 aiStore ensureSettingsShape 的记忆字段逐条对齐)。
 * 上下文预算/迭代步数/压缩阈值等字段由 dsh harness 接管,不再读也不写;
 * 旧版命令白名单字段(commandWhitelist / commandWhitelistVersion)一并丢弃。
 * @param raw - 从 localStorage 读出的 settings 对象(可能缺字段/类型错)。
 * @returns 归一化后的设置(缺省回落默认值,只含保留字段)。
 */
export function normalizeAiSettings(raw: Partial<AiSettings> | null | undefined): AiSettings {
  const base = defaultAiSettings()
  const next: AiSettings = {
    ...base,
    ...(raw ?? {}),
  }
  // 旧版白名单字段随「统一走 deepseek-harness 权限体系」移除,写回时不再保留
  delete (next as Record<string, unknown>).commandWhitelist
  delete (next as Record<string, unknown>).commandWhitelistVersion
  if (typeof next.memoryStoreToolOutputs !== 'boolean') next.memoryStoreToolOutputs = false
  if (typeof next.memoryEnabled !== 'boolean') next.memoryEnabled = true
  if (typeof next.memoryWriteNeedsConfirm !== 'boolean') next.memoryWriteNeedsConfirm = false
  if (typeof next.memoryAutoReview !== 'boolean') next.memoryAutoReview = true
  return next
}

/** localStorage 里的 pinia 持久化结构({ settings, agents, conversationSummaries })。 */
interface AiPersistedState {
  settings?: unknown
  agents?: unknown
  conversationSummaries?: unknown
}

/**
 * 读取 AI 设置(从 ai-v2 的 settings 字段)。
 * @returns 归一化后的设置(无持久化数据时返回默认值)。
 */
export function loadAiSettings(): AiSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? 'null') as AiPersistedState | null
    return normalizeAiSettings(raw?.settings as Partial<AiSettings> | undefined)
  } catch {
    return defaultAiSettings()
  }
}

/**
 * 写回 AI 设置(只替换 settings 字段,agents/conversationSummaries 原样保留)。
 * @param settings - 归一化后的设置。
 */
export function saveAiSettings(settings: AiSettings): void {
  try {
    const raw = JSON.parse(localStorage.getItem(AI_STORAGE_KEY) ?? 'null') as AiPersistedState | null
    localStorage.setItem(AI_STORAGE_KEY, JSON.stringify({ ...(raw ?? {}), settings }))
  } catch {
    // localStorage 不可用(隐私模式等):静默降级,与 aiStore 持久化失败语义一致
  }
}
