/**
 * AI 设置持久化桥(React 壳内版,settings AI tab 用)。
 *
 * 读写与 Vue 版 `src/stores/ai.ts` 同一份 localStorage(pinia 持久化
 * key `ai-v2`,paths 含 settings):本模块只碰 AI tab 未随 dsh 接管而保留
 * 的两个区块——命令白名单(05)与记忆与上下文(06),其余字段原样保留。
 * 白名单 V3 跨平台预设迁移、各字段默认值与类型守卫与 aiStore 的
 * ensureSettingsShape 逐条对齐(铁律 5)。
 */

/** localStorage key(与 aiStore 的 persist key 同名,用户数据无缝)。 */
export const AI_STORAGE_KEY = 'ai-v2'

/** PowerShell 只读命令 V3 预设(aiStore 的 LOCAL_COMMAND_WHITELIST_V3)。 */
const LOCAL_COMMAND_WHITELIST_V3 = [
  'Get-ChildItem', 'Get-Content', 'Select-String', 'Get-Item', 'Get-Location',
  'Get-Process', 'Get-Service', 'Get-CimInstance', 'Get-ComputerInfo',
  'Test-Path', 'Resolve-Path', 'Measure-Object', 'Compare-Object',
  'Get-NetTCPConnection', 'Get-NetIPAddress', 'Get-DnsClientCache',
]

/** 默认白名单(aiStore 的 DEFAULT_COMMAND_WHITELIST)。 */
const DEFAULT_COMMAND_WHITELIST = [
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'find', 'pwd',
  'echo', 'df', 'du', 'free', 'top', 'ps', 'uptime', 'uname', 'whoami',
  'date', 'wc', 'sort', 'uniq', 'awk', 'cut', 'tr', 'stat', 'file',
  'which', 'whereis', 'type', 'id', 'env', 'printenv', 'hostname',
  'netstat', 'ss', 'ip', 'ifconfig', 'route', 'ping', 'traceroute',
  'curl', 'wget', 'nslookup', 'dig', 'host',
  'systemctl status', 'systemctl is-active', 'systemctl is-enabled',
  'journalctl', 'dmesg', 'lsof',
  'docker ps', 'docker logs', 'docker inspect', 'docker images',
  'docker network ls', 'docker volume ls',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'mysql -e "SELECT', 'mysql -e "SHOW', 'mysql -e "DESCRIBE',
  'redis-cli GET', 'redis-cli HGET', 'redis-cli HGETALL', 'redis-cli LRANGE',
  'redis-cli SMEMBERS', 'redis-cli ZRANGE', 'redis-cli KEYS',
  ...LOCAL_COMMAND_WHITELIST_V3,
]

/** AI 设置(只声明 AI tab 保留区块相关字段,其余原样透传)。 */
export interface AiSettings {
  commandWhitelist: string[]
  commandWhitelistVersion: number
  memoryStoreToolOutputs: boolean
  contextBudgetChars: number
  agentMaxSteps: number
  memoryEnabled: boolean
  memoryWriteNeedsConfirm: boolean
  memoryAutoReview: boolean
  compactTriggerRatio: number
}

/** 默认值(与 aiStore settings 初始值一致;commandWhitelistVersion 初始 2 触发一次 v3 迁移)。 */
function defaultAiSettings(): AiSettings {
  return {
    commandWhitelist: [...DEFAULT_COMMAND_WHITELIST],
    commandWhitelistVersion: 2,
    memoryStoreToolOutputs: false,
    contextBudgetChars: 120_000,
    agentMaxSteps: 20,
    memoryEnabled: true,
    memoryWriteNeedsConfirm: false,
    memoryAutoReview: true,
    compactTriggerRatio: 0.5,
  }
}

/**
 * 归一化一次持久化 settings(与 aiStore ensureSettingsShape 的白名单/记忆字段逐条对齐)。
 * 空数据同样走迁移流(默认 version=2 → 合并 V3 预设并置 3,与 Vue 首次 ensureSettingsShape 一致)。
 * @param raw - 从 localStorage 读出的 settings 对象(可能缺字段/类型错)。
 * @returns 归一化后的设置(缺省回落默认值)。
 */
export function normalizeAiSettings(raw: Partial<AiSettings> | null | undefined): AiSettings {
  const base = defaultAiSettings()
  const next: AiSettings = { ...base, ...(raw ?? {}) }
  if (!Array.isArray(next.commandWhitelist)) {
    next.commandWhitelist = [...DEFAULT_COMMAND_WHITELIST]
  } else {
    next.commandWhitelist = next.commandWhitelist.filter((item): item is string => typeof item === 'string')
  }
  if (!Number.isFinite(next.commandWhitelistVersion) || next.commandWhitelistVersion < 3) {
    next.commandWhitelist = Array.from(new Set([...next.commandWhitelist, ...LOCAL_COMMAND_WHITELIST_V3]))
    next.commandWhitelistVersion = 3
  }
  if (typeof next.memoryStoreToolOutputs !== 'boolean') next.memoryStoreToolOutputs = false
  if (!Number.isFinite(next.contextBudgetChars) || next.contextBudgetChars < 4_000) next.contextBudgetChars = 120_000
  if (!Number.isFinite(next.agentMaxSteps) || next.agentMaxSteps < 1 || next.agentMaxSteps > 100) next.agentMaxSteps = 20
  if (typeof next.memoryEnabled !== 'boolean') next.memoryEnabled = true
  if (typeof next.memoryWriteNeedsConfirm !== 'boolean') next.memoryWriteNeedsConfirm = false
  if (typeof next.memoryAutoReview !== 'boolean') next.memoryAutoReview = true
  if (!Number.isFinite(next.compactTriggerRatio) || next.compactTriggerRatio <= 0 || next.compactTriggerRatio > 1) {
    next.compactTriggerRatio = 0.5
  }
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
