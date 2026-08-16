/**
 * Settings 插件 tab(React 壳内版)——自 SettingsView.vue 597-904(逻辑)/
 * 1846-2006(模板)迁移:已装插件列表 + URL/本地导入三入口 + 市场(分类/搜索)
 * + 首次启用风险确认 + 卸载确认。isTauriRuntime 守卫、afterPluginMutation
 * 三步顺序、PLUGIN_ACK_KEY 确认语义全部原样保留。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { tauriInvoke } from '../tauri.ts'
import {
  fetchPluginMarket, installLocalPlugin, installPluginFromUrl, isTauriRuntime, listPlugins,
  setPluginEnabled, shutdownDshRuntime, uninstallPlugin,
  type DshMarketCatalog, type DshPluginInfo,
} from './services.ts'
import s from './settings.module.css'

/** 首次启用风险提示的确认记录(localStorage,按插件 id 记一次)。 */
const PLUGIN_ACK_KEY = 'starhub.plugins.enable-acknowledged'

/** 插件来源文案(Vue pluginSourceLabel)。 */
function pluginSourceLabel(kind: string): string {
  switch (kind) {
    case 'market': return '市场'
    case 'url': return 'URL'
    case 'local-dir': return '目录'
    case 'local-zip': return 'Zip'
    default: return kind
  }
}

/** 读启用确认集合(解析失败返回空集)。 */
function pluginAckSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PLUGIN_ACK_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/** 追加一条启用确认记录。 */
function markPluginAcked(id: string): void {
  try {
    localStorage.setItem(PLUGIN_ACK_KEY, JSON.stringify([...pluginAckSet(), id]))
  } catch {
    // localStorage 不可用时静默降级
  }
}

/**
 * 渲染插件管理:列表 + 安装入口 + 市场。
 * @returns 插件 tab 内容。
 */
export function PluginsTab() {
  const [pluginList, setPluginList] = useState<DshPluginInfo[]>([])
  const [pluginLoading, setPluginLoading] = useState(false)
  const [pluginError, setPluginError] = useState('')
  const [pluginBusyId, setPluginBusyId] = useState('')
  const [pluginUrl, setPluginUrl] = useState('')
  const [pluginUrlInstalling, setPluginUrlInstalling] = useState(false)
  const [marketCatalog, setMarketCatalog] = useState<DshMarketCatalog | null>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketSearch, setMarketSearch] = useState('')
  const [riskDialogPlugin, setRiskDialogPlugin] = useState<DshPluginInfo | null>(null)
  const [uninstallDialogPlugin, setUninstallDialogPlugin] = useState<DshPluginInfo | null>(null)

  const loadPlugins = useCallback(async () => {
    if (!isTauriRuntime()) return
    setPluginLoading(true)
    setPluginError('')
    try {
      setPluginList(await listPlugins())
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginLoading(false)
    }
  }, [])

  const loadMarket = useCallback(async (force = false) => {
    if (!isTauriRuntime()) return
    setMarketLoading(true)
    try {
      setMarketCatalog(await fetchPluginMarket(force))
    } catch {
      // Rust 侧已降级为空目录,这里只兜底 IPC 级失败
      setMarketCatalog({ stale: false, categories: [] })
    } finally {
      setMarketLoading(false)
    }
  }, [])

  // 切到本 tab 时懒加载(与 Vue watch(activeTab) 一致)
  useEffect(() => {
    if (pluginList.length === 0) void loadPlugins()
    if (marketCatalog === null) void loadMarket()
  }, [loadPlugins, loadMarket, pluginList.length, marketCatalog])

  const marketFiltered = useMemo(() => {
    const catalog = marketCatalog
    if (catalog === null) return []
    const keyword = marketSearch.trim().toLowerCase()
    if (keyword === '') return catalog.categories
    return catalog.categories
      .map((category) => ({
        ...category,
        plugins: category.plugins.filter((plugin) =>
          plugin.name.toLowerCase().includes(keyword)
          || plugin.description.toLowerCase().includes(keyword)
          || (plugin.npm ?? '').toLowerCase().includes(keyword)),
      }))
      .filter((category) => category.plugins.length > 0)
  }, [marketCatalog, marketSearch])

  /** 变更后收尾:关 runtime(下次对话重启生效)+ 刷新列表。 */
  const afterPluginMutation = useCallback(async (message: string) => {
    try {
      await shutdownDshRuntime()
    } catch {
      // runtime 未运行属正常情况
    }
    void loadPlugins()
    return message
  }, [loadPlugins])

  const doSetPluginEnabled = useCallback(async (plugin: DshPluginInfo, enabled: boolean) => {
    setPluginBusyId(plugin.id)
    setPluginError('')
    try {
      await setPluginEnabled(plugin.id, enabled)
      await afterPluginMutation(enabled ? '插件已启用' : '插件已禁用')
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginBusyId('')
    }
  }, [afterPluginMutation])

  /** 启停开关:启用且首次时需先过风险提示确认卡。 */
  const onTogglePlugin = (plugin: DshPluginInfo) => {
    if (pluginBusyId !== '') return
    if (plugin.enabled) {
      void doSetPluginEnabled(plugin, false)
      return
    }
    if (pluginAckSet().has(plugin.id)) {
      void doSetPluginEnabled(plugin, true)
      return
    }
    setRiskDialogPlugin(plugin)
  }

  const confirmRiskEnable = async () => {
    const plugin = riskDialogPlugin
    setRiskDialogPlugin(null)
    // v8 ignore next -- 弹窗仅在 plugin 非空时渲染,确认函数先取再清
    if (plugin === null) return
    markPluginAcked(plugin.id)
    await doSetPluginEnabled(plugin, true)
  }

  const confirmUninstall = async () => {
    const plugin = uninstallDialogPlugin
    setUninstallDialogPlugin(null)
    // v8 ignore next -- 弹窗仅在 plugin 非空时渲染,确认函数先取再清
    if (plugin === null) return
    setPluginBusyId(plugin.id)
    setPluginError('')
    try {
      await uninstallPlugin(plugin.id)
      await afterPluginMutation('插件已卸载')
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginBusyId('')
    }
  }

  const onInstallUrl = async () => {
    const url = pluginUrl.trim()
    if (url === '' || pluginUrlInstalling) return
    setPluginUrlInstalling(true)
    setPluginError('')
    try {
      await installPluginFromUrl(url)
      setPluginUrl('')
      await afterPluginMutation('插件已安装')
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginUrlInstalling(false)
    }
  }

  /** 本地导入(directory=true 选目录;否则选 .zip);浏览器预览无原生对话框 → null。 */
  const pickLocalPath = async (directory: boolean): Promise<string | null> => {
    if (!isTauriRuntime()) return null
    const picked = await tauriInvoke<string | string[] | null>('plugin:dialog|open', {
      options: {
        directory,
        multiple: false,
        ...(directory ? {} : { filters: [{ name: '插件压缩包', extensions: ['zip'] }] }),
      },
    })
    if (Array.isArray(picked)) return picked[0] ?? null
    return picked
  }

  const onImportLocal = async (directory: boolean) => {
    // v8 ignore next -- 导入按钮在 busy 时禁用,守卫为直接调用路径的防御分支
    if (pluginBusyId !== '') return
    const path = await pickLocalPath(directory)
    if (path === null) return
    setPluginBusyId('(import)')
    setPluginError('')
    try {
      await installLocalPlugin(path)
      await afterPluginMutation('插件已导入')
    } catch (error) {
      setPluginError(error instanceof Error ? error.message : String(error))
    } finally {
      setPluginBusyId('')
    }
  }

  const installedByUrl = (url: string) => pluginList.some((plugin) => url.includes(plugin.id))

  return (
    <div className={s.panel}>
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionNumber}>01</span>
          <span className={s.sectionTitle}>已安装插件</span>
          <span className={s.spacer} />
          <button
            type="button" className={s.btnSecondary} title="刷新" aria-label="刷新"
            disabled={pluginLoading} onClick={() => void loadPlugins()}
          >
            {pluginLoading ? '…' : '刷新'}
          </button>
        </div>
        {pluginError !== '' && <div className={s.errorText}>{pluginError}</div>}
        {pluginList.length === 0 ? (
          <div className={s.empty}>暂无已安装插件。</div>
        ) : (
          <div className={s.cardList}>
            {pluginList.map((plugin) => (
              <div key={plugin.id} className={`${s.card} ${plugin.enabled ? '' : s.disabled}`}>
                <div className={s.cardHead}>
                  <span className={s.cardName}>{plugin.name}</span>
                  <span className={plugin.enabled ? s.badge : s.badgeOff}>
                    {plugin.enabled ? '已启用' : '已禁用'}
                  </span>
                  <span className={s.badgeOff}>未验证</span>
                  {plugin.missing === true && <span className={s.badgeOff}>缺失</span>}
                  <span className={s.cardActions}>
                    <button
                      type="button" className={s.iconButton}
                      title={plugin.enabled ? '禁用' : '启用'}
                      aria-label={plugin.enabled ? '禁用' : '启用'}
                      disabled={pluginBusyId === plugin.id || plugin.missing === true}
                      onClick={() => onTogglePlugin(plugin)}
                    >
                      {pluginBusyId === plugin.id ? '…' : plugin.enabled ? '⏻' : '○'}
                    </button>
                    <button
                      type="button" className={s.iconButton}
                      title="卸载" aria-label="卸载"
                      disabled={pluginBusyId === plugin.id}
                      onClick={() => setUninstallDialogPlugin(plugin)}
                    >
                      <IconCloseOutline16 size={13} />
                    </button>
                  </span>
                </div>
                <div className={s.cardMeta}>
                  <span>v{plugin.version}</span>
                  {plugin.license !== undefined && <span>{plugin.license}</span>}
                  <span>{pluginSourceLabel(plugin.source.kind)}</span>
                  {plugin.description !== undefined && <span>{plugin.description}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionNumber}>02</span>
          <span className={s.sectionTitle}>安装插件</span>
        </div>
        <div className={s.toolbar}>
          <input
            className={s.input} placeholder="GitHub 仓库 URL 或 zip 直链"
            value={pluginUrl}
            onChange={(event) => setPluginUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void onInstallUrl() }}
          />
          <button
            type="button" className={s.btn} disabled={pluginUrlInstalling || pluginUrl.trim() === ''}
            onClick={() => void onInstallUrl()}
          >
            {pluginUrlInstalling ? '安装中…' : 'URL 安装'}
          </button>
          <button
            type="button" className={s.btnSecondary} disabled={pluginBusyId !== ''}
            onClick={() => void onImportLocal(true)}
          >
            导入目录
          </button>
          <button
            type="button" className={s.btnSecondary} disabled={pluginBusyId !== ''}
            onClick={() => void onImportLocal(false)}
          >
            导入 Zip
          </button>
        </div>
      </div>

      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionNumber}>03</span>
          <span className={s.sectionTitle}>插件市场</span>
          <span className={s.spacer} />
          <input
            className={`${s.input} ${s.marketSearch}`} placeholder="搜索插件…"
            value={marketSearch}
            onChange={(event) => setMarketSearch(event.target.value)}
          />
          <button
            type="button" className={s.btnSecondary} disabled={marketLoading}
            onClick={() => void loadMarket(true)}
          >
            刷新
          </button>
        </div>
        {marketFiltered.length === 0 ? (
          <div className={s.empty}>暂无市场插件。</div>
        ) : (
          marketFiltered.map((category) => (
            <div key={category.name} className={s.marketCategory}>
              <div className={s.sectionDesc}>{category.name}</div>
              <div className={s.cardList}>
                {category.plugins.map((plugin) => (
                  <div key={plugin.url} className={s.card}>
                    <div className={s.cardHead}>
                      <span className={s.cardName}>{plugin.name}</span>
                      {plugin.stars !== undefined && (
                        <span className={s.cardMetric}>★ {plugin.stars}</span>
                      )}
                      <span className={s.badgeOff}>未验证</span>
                      <span className={s.cardActions}>
                        <button
                          type="button" className={s.btnSecondary}
                          disabled={pluginUrlInstalling || installedByUrl(plugin.url)}
                          onClick={() => void onInstallUrlFromMarket(plugin.url, setPluginUrlInstalling, setPluginError, afterPluginMutation)}
                        >
                          {installedByUrl(plugin.url) ? '已安装' : '安装'}
                        </button>
                      </span>
                    </div>
                    <div className={s.cardMeta}>
                      {plugin.description !== '' && <span>{plugin.description}</span>}
                      {plugin.npm !== undefined && <span>npm: {plugin.npm}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {riskDialogPlugin !== null && (
        <ConfirmActionDialog
          title="启用插件"
          message={`${riskDialogPlugin.name}\n\n该插件来自第三方,启用后其代码将在本机执行。请确认来源可信。`}
          confirmText="启用"
          danger
          onCancel={() => setRiskDialogPlugin(null)}
          onConfirm={() => void confirmRiskEnable()}
        />
      )}
      {uninstallDialogPlugin !== null && (
        <ConfirmActionDialog
          title="卸载插件"
          message={`确定卸载插件「${uninstallDialogPlugin.name}」?`}
          confirmText="卸载"
          danger
          onCancel={() => setUninstallDialogPlugin(null)}
          onConfirm={() => void confirmUninstall()}
        />
      )}
    </div>
  )
}

/** 市场安装按钮的独立入口(与 URL 安装共用防重入与收尾)。 */
async function onInstallUrlFromMarket(
  url: string,
  setInstalling: (value: boolean) => void,
  setError: (value: string) => void,
  afterMutation: (message: string) => Promise<string>,
): Promise<void> {
  setInstalling(true)
  setError('')
  try {
    await installPluginFromUrl(url)
    await afterMutation('插件已安装')
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error))
  } finally {
    setInstalling(false)
  }
}

/** 确认弹窗(风险提示 / 卸载共用)。 */
export function ConfirmActionDialog(props: {
  title: string
  message: string
  confirmText: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className={s.dialogBackdrop} role="presentation" onMouseDown={props.onCancel}>
      <div
        className={s.dialogPanel}
        role="dialog"
        aria-label={props.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={s.dialogHead}>
          <span className={s.dialogTitle}>{props.title}</span>
          <button type="button" className={s.iconButton} aria-label="关闭" onClick={props.onCancel}>
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        <pre className={`${s.hint} ${s.confirmMessage}`}>{props.message}</pre>
        <div className={s.actionRow}>
          <button type="button" className={s.btnSecondary} onClick={props.onCancel}>取消</button>
          <button type="button" className={props.danger === true ? s.btnDanger : s.btn} onClick={props.onConfirm}>
            {props.confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
