/**
 * StarHub 工具工作区列(方案 P1,重构版):右侧工具工作区列显示当前子类
 * (终端 / 数据库 / Docker)的资产(连接)列表;点资产行经注入的 openAsset
 * 回调打开该实例的操作页(shell.overlay iframe)。列头带资产数、刷新与
 * 「新建连接」入口(经 openConnectionManager 打开连接管理 overlay ——
 * 设置页只挂资产 tab 的整幅层)。
 *
 * 浏览器预览(无 Tauri IPC)时 refresh 落入 preview 态,这里展示预览提示
 * 而不是红错;其他拉取失败给错误 + 重试。
 *
 * 本组件同时挂在 workspace(无会话)与 details.workspace(有会话)两座
 * session-maybe 席位上;框架在无会话分支不下发注册侧 store,故全部共享
 * 状态都走 inject hooks 舱位的裸 source(useSelection / useAssets),写入
 * 走注入回调(openAsset / refreshAssets / openConnectionManager)。挂载与
 * 切换子类时调 refreshAssets 重拉 get_assets,保证新建/删除连接后列表新鲜。
 */
import { useEffect } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'workspace' / 'details.workspace' SlotMap rows.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconPlusOutline16, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SUBCATEGORIES, type StarHubAsset } from './sections.ts'
import type { StarHubAssetListState, ToolSelection } from './store.ts'
import css from './StarHubToolWorkspace.module.css'

/** Settings namespace written by the shell (host reads it per request). */
const TOOL_CONTEXT_NAMESPACE = 'starhub-tool-context'

/** Business face injected by the registration: the connection wire + bridge/asset writes. */
export interface StarHubToolWorkspaceInjected {
  api: IApiClient
  openAsset: (asset: StarHubAsset) => void
  refreshAssets: () => void
  /** 打开连接管理 overlay(设置页资产 tab):新建/编辑/删除连接的唯一入口。 */
  openConnectionManager: () => void
  hooks: {
    selection: SnapshotStore<ToolSelection>
    assets: SnapshotStore<StarHubAssetListState>
  }
}

/** Full composed props: workspace runtime share + the injected face (no slot store — see header). */
export type StarHubToolWorkspaceProps =
  & PropsRuntime<'workspace'>
  & InjectFace<StarHubToolWorkspaceInjected>

/** 资产副标题(user@host 之类,取最常用字段;没有就不显示)。 */
function assetSubtitle(asset: { config: Record<string, unknown> }): string {
  const c = asset.config
  const host = typeof c.host === 'string' ? c.host : ''
  const username = typeof c.username === 'string' ? c.username : ''
  if (host !== '' && username !== '') return `${username}@${host}`
  if (host !== '') return host
  return typeof c.database === 'string' ? c.database : ''
}

/**
 * Render the in-shell tool workspace column: header (subcategory label,
 * count, refresh, 新建连接) above the current subcategory's asset list;
 * clicking a row opens that instance's operation page. Also syncs the
 * current tool selection to host settings for AI context (Path B plan 4.3) —
 * the patch is always the full four fields, empty string clearing the key, so
 * a deselected asset never lingers as stale AI context.
 * @param props - composed slot props (workspace runtime share + injected face).
 * @returns the asset list surface, or a guide/loading/preview/error/empty state.
 */
export function StarHubToolWorkspace({
  api, openAsset, refreshAssets, openConnectionManager, useSelection, useAssets,
}: StarHubToolWorkspaceProps) {
  const assets = useAssets(s => s.assets)
  const loading = useAssets(s => s.loading)
  const error = useAssets(s => s.error)
  const preview = useAssets(s => s.preview)
  const activeSubcategory = useSelection(s => s.subcategory)
  const activeAssetId = useSelection(s => s.assetId)
  const activeRoutePrefix = useSelection(s => s.routePrefix)
  const subcategory = STARHUB_SUBCATEGORIES.find(s => s.key === activeSubcategory)

  // 挂载与切换子类时都重新拉取(回调内部对并发拉取去重)。
  useEffect(() => { refreshAssets() }, [activeSubcategory, refreshAssets])

  // 4.3: 当前工具选择 → host settings(供 agent/pre-step 注入 AI 上下文)。
  // 全量四字段:取消选中写空串清除,避免过期资产滞留成 AI 上下文。
  useEffect(() => {
    if (api === undefined) return
    const asset = activeAssetId !== null ? assets.find(a => a.id === activeAssetId) : undefined
    const patch = {
      subcategory: subcategory?.key ?? '',
      assetId: asset?.id ?? '',
      assetName: asset?.name ?? '',
      routePrefix: (activeAssetId !== null ? activeRoutePrefix : null) ?? subcategory?.routePrefix ?? '',
    }
    void api.settings.update({ ns: TOOL_CONTEXT_NAMESPACE, patch }).catch(() => {})
  }, [api, subcategory, activeAssetId, activeRoutePrefix, assets])

  if (subcategory === undefined) {
    return <div className={css.status}>请在左侧选择工具子类(终端 / 数据库 / Docker)。</div>
  }

  const matched = assets.filter(subcategory.matches)

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{subcategory.label}</span>
        {!preview && !loading && error === null && <span className={css.count}>{matched.length}</span>}
        <span className={css.spacer} />
        <button
          type="button"
          className={css.iconButton}
          title="刷新"
          aria-label="刷新"
          disabled={loading}
          onClick={() => refreshAssets()}
        >
          <IconRefreshOutline14 size={13} />
        </button>
        <button type="button" className={css.newButton} onClick={() => openConnectionManager()}>
          <IconPlusOutline16 size={12} />
          <span>新建连接</span>
        </button>
      </div>
      {loading && <div className={css.status}>加载资产…</div>}
      {!loading && preview && (
        <div className={css.status}>
          <div className={css.previewTitle}>浏览器预览模式</div>
          <div>当前页面跑在纯浏览器里,没有 StarHub 桌面端后端(Tauri IPC),资产列表不可用。</div>
          <div>请在 StarHub 桌面应用中打开本页管理连接。</div>
        </div>
      )}
      {!loading && !preview && error !== null && (
        <div className={css.status}>
          <div>资产加载失败:{error}</div>
          <button type="button" className={css.retryButton} onClick={() => refreshAssets()}>重试</button>
        </div>
      )}
      {!loading && !preview && error === null && matched.length === 0 && (
        <div className={css.status}>
          <div>暂无 {subcategory.label} 连接。</div>
          <button type="button" className={css.retryButton} onClick={() => openConnectionManager()}>
            新建连接
          </button>
        </div>
      )}
      {!loading && !preview && error === null && matched.length > 0 && (
        <div className={css.list}>
          {matched.map((asset) => (
            <button
              key={asset.id}
              type="button"
              className={css.row}
              title={`打开 ${asset.name}`}
              onClick={() => openAsset(asset)}
            >
              <span className={css.badge}>{subcategory.label}</span>
              <span className={css.rowName}>{asset.name}</span>
              <span className={css.rowSub}>{assetSubtitle(asset)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
