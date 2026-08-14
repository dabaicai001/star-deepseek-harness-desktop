/**
 * dsh 用户插件管理前端封装(AI 内核替换支线 B,方案 8.3)。
 *
 * 对应 Rust 侧 `src-tauri/src/harness/plugins.rs` + `commands/dsh_plugins.rs`:
 * - 插件安装在应用数据目录 `plugins/<id>/`,启停状态落在自动生成的
 *   `plugins/cordis.yml`(entry 的 disabled 字段);
 * - 首版只支持零依赖运行时类插件(带 dependencies 或 UI/皮肤类会被 Rust 拒装);
 * - 每次安装 / 启停 / 卸载后需重启 dsh runtime 生效:调用方负责在操作成功后
 *   调 `aiHarness.shutdown()`,下一轮对话 initialize 时自动带新配置重启。
 */
import { invoke } from '@tauri-apps/api/core'

/** 插件来源 */
export interface DshPluginSource {
  /** market / url / local-dir / local-zip */
  kind: string
  /** 来源 URL 或本地路径 */
  location?: string
}

/** 已安装插件(registry.json 记录 + missing 标记) */
export interface DshPluginInfo {
  /** 目录名与 entry id(包名清洗而来) */
  id: string
  /** package.json 原始 name */
  name: string
  version: string
  description?: string
  license?: string
  source: DshPluginSource
  /** 入口文件(插件目录内相对路径) */
  entry: string
  /** 启停状态;新装默认为 false */
  enabled: boolean
  installedAt?: string
  /** true = registry 有记录但目录已被外部删除 */
  missing?: boolean
}

/** 市场条目(owner/repo) */
export interface DshMarketPlugin {
  name: string
  url: string
  description: string
  stars?: number
  npm?: string
}

export interface DshMarketCategory {
  name: string
  plugins: DshMarketPlugin[]
}

/** 市场目录;stale=true 表示本次抓取失败回退了缓存 */
export interface DshMarketCatalog {
  fetchedAt?: string
  stale: boolean
  categories: DshMarketCategory[]
}

/** 已安装插件列表 */
export async function listPlugins(): Promise<DshPluginInfo[]> {
  return invoke<DshPluginInfo[]>('dsh_plugin_list')
}

/** 本地导入:插件目录或 .zip 文件路径,返回安装记录(默认关闭) */
export async function installLocalPlugin(path: string): Promise<DshPluginInfo> {
  return invoke<DshPluginInfo>('dsh_plugin_install_local', { path })
}

/** URL 安装:GitHub 仓库地址(可带 /tree/<branch>)或 zip 直链 */
export async function installPluginFromUrl(url: string): Promise<DshPluginInfo> {
  return invoke<DshPluginInfo>('dsh_plugin_install_url', { url })
}

/** 逐项启停(需重启 runtime 生效) */
export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke('dsh_plugin_set_enabled', { id, enabled })
}

/** 卸载(需重启 runtime 生效) */
export async function uninstallPlugin(id: string): Promise<void> {
  await invoke('dsh_plugin_uninstall', { id })
}

/**
 * 拉取插件市场目录(awesome-dsh-plugin 精选索引,CC0)。
 * 抓取失败不抛错:有缓存回缓存(stale=true),无缓存返回空目录。
 */
export async function fetchPluginMarket(forceRefresh = false): Promise<DshMarketCatalog> {
  return invoke<DshMarketCatalog>('dsh_plugin_market_fetch', { forceRefresh })
}
