/**
 * StarHub 工具工作区页签(Phase 0 spike,Step 1)。
 *
 * 注册进 `conversation.view`(聊天区页签环),壳内 React 直渲 —— 无 iframe。
 * 挂载时经顶层帧 Tauri IPC 直调 `get_assets`(P0 spike 已实测顶层帧
 * `__TAURI_INTERNALS__.invoke` 可用),结果写入共享 asset store。
 * 纯浏览器预览(无 Tauri)时降级展示错误提示。
 */
import { useEffect } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'conversation.view' SlotMap row (declared by ui-conversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createStarHubAssetStore, RustAsset } from './asset-store.ts'

/** Full composed props: conversation view runtime share + the shared asset store share. */
export type StarHubToolWorkspaceProps =
  & PropsRuntime<'conversation.view'>
  & PropsStore<ReturnType<typeof createStarHubAssetStore>>

/** Tauri IPC surface injected into the top frame by the desktop shell. */
interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

/** 顶层帧 Tauri IPC 直调;浏览器预览(无 Tauri)时 reject。 */
function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals === undefined) {
    return Promise.reject(new Error('Tauri IPC unavailable (browser preview)'))
  }
  return internals.invoke(cmd, args) as Promise<T>
}

/** 资产副标题(user@host 之类,取最常用字段;没有就不显示)。 */
function assetSubtitle(asset: RustAsset): string {
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
  background: 'var(--dsw-background-secondary, rgba(255,255,255,0.04))',
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
 * Render the in-shell StarHub asset list as a conversation view tab.
 * @param props - composed slot props (view runtime share + asset store share).
 * @returns the asset list surface, or a loading/error/empty state.
 */
export function StarHubToolWorkspace({ useStore, actions }: StarHubToolWorkspaceProps) {
  const assets = useStore(s => s.assets)
  const loading = useStore(s => s.loading)
  const error = useStore(s => s.error)

  useEffect(() => {
    if (loading || assets.length > 0) return
    actions.setLoading(true)
    actions.setError(null)
    tauriInvoke<RustAsset[]>('get_assets')
      .then((list) => { actions.setAssets(list) })
      .catch((e: unknown) => { actions.setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { actions.setLoading(false) })
  }, [loading, assets.length, actions])

  if (loading) return <div style={statusStyle}>加载资产…</div>
  if (error !== null) return <div style={statusStyle}>资产加载失败:{error}</div>
  if (assets.length === 0) return <div style={statusStyle}>暂无资产,请在设置中添加。</div>

  return (
    <div style={listStyle}>
      <div style={{ fontSize: 11, color: 'var(--dsw-foreground-secondary, #9aa7b4)', padding: '0 4px' }}>
        StarHub 资产({assets.length})
      </div>
      {assets.map((asset) => (
        <div key={asset.id} style={rowStyle}>
          <span style={badgeStyle}>{asset.type}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {asset.name}
          </span>
          <span style={{ color: 'var(--dsw-foreground-secondary, #9aa7b4)', fontSize: 12 }}>
            {assetSubtitle(asset)}
          </span>
        </div>
      ))}
    </div>
  )
}
