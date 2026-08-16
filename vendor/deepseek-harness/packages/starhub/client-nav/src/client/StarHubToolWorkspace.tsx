/**
 * StarHub 工具工作区列(方案 P1):右侧工具工作区列显示当前子类(终端 /
 * 数据库 / Docker)的资产(连接)列表;点资产行经注入的 openAsset 回调
 * 打开该实例的操作页(shell.overlay iframe)。
 *
 * 本组件同时挂在 workspace(无会话)与 details.workspace(有会话)两座
 * session-maybe 席位上;框架在无会话分支不下发注册侧 store,故全部共享
 * 状态都走 inject hooks 舱位的裸 source(useSelection / useAssets),写入
 * 走注入回调(openAsset / refreshAssets)。挂载与切换子类时调
 * refreshAssets 重拉 get_assets,保证设置里新建/删除连接后列表新鲜。
 */
import { useEffect } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'workspace' / 'details.workspace' SlotMap rows.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { STARHUB_SUBCATEGORIES, type StarHubAsset } from './sections.ts'
import type { StarHubAssetListState, ToolSelection } from './store.ts'

/** Settings namespace written by the shell (host reads it per request). */
const TOOL_CONTEXT_NAMESPACE = 'starhub-tool-context'

/** Business face injected by the registration: the connection wire + bridge/asset writes. */
export interface StarHubToolWorkspaceInjected {
  api: IApiClient
  openAsset: (asset: StarHubAsset) => void
  refreshAssets: () => void
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

const listStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  padding: 12, fontSize: 13,
}

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 10px', borderRadius: 6,
  border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 13, fontFamily: 'inherit',
  background: 'var(--dsw-background-secondary, rgba(255,255,255,0.04))',
  textAlign: 'left', width: '100%',
}

const badgeStyle: React.CSSProperties = {
  fontSize: 11, padding: '1px 8px', borderRadius: 999,
  background: 'var(--dsw-accent-weak, rgba(93,214,214,0.15))',
  color: 'var(--dsw-accent, #5dd6d6)',
  whiteSpace: 'nowrap',
}

const statusStyle: React.CSSProperties = {
  padding: '16px 12px', fontSize: 13,
  color: 'var(--dsw-foreground-secondary, #9aa7b4)',
}

/**
 * Render the in-shell tool workspace column: the current subcategory's asset
 * list; clicking a row opens that instance's operation page. Also syncs the
 * current tool selection to host settings for AI context (Path B plan 4.3) —
 * the patch is always the full four fields, empty string clearing the key, so
 * a deselected asset never lingers as stale AI context.
 * @param props - composed slot props (workspace runtime share + injected face).
 * @returns the asset list surface, or a loading/error/empty/guide state.
 */
export function StarHubToolWorkspace({ api, openAsset, refreshAssets, useSelection, useAssets }: StarHubToolWorkspaceProps) {
  const assets = useAssets(s => s.assets)
  const loading = useAssets(s => s.loading)
  const error = useAssets(s => s.error)
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
    return <div style={statusStyle}>请在左侧选择工具子类(终端 / 数据库 / Docker)。</div>
  }

  if (loading) return <div style={statusStyle}>加载资产…</div>
  if (error !== null) return <div style={statusStyle}>资产加载失败:{error}</div>

  const matched = assets.filter(subcategory.matches)
  if (matched.length === 0) {
    return (
      <div style={statusStyle}>
        暂无 {subcategory.label} 资产,请先在设置中添加连接。
      </div>
    )
  }

  return (
    <div style={listStyle}>
      <div style={{ fontSize: 11, color: 'var(--dsw-foreground-secondary, #9aa7b4)', padding: '0 4px' }}>
        {subcategory.label}({matched.length})
      </div>
      {matched.map((asset) => (
        <button
          key={asset.id}
          type="button"
          style={rowStyle}
          title={`打开 ${asset.name}`}
          onClick={() => openAsset(asset)}
        >
          <span style={badgeStyle}>{subcategory.label}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {asset.name}
          </span>
          <span style={{ color: 'var(--dsw-foreground-secondary, #9aa7b4)', fontSize: 12 }}>
            {assetSubtitle(asset)}
          </span>
        </button>
      ))}
    </div>
  )
}
