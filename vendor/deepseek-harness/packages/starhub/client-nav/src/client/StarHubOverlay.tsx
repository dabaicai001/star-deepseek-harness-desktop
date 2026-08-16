/**
 * StarHub overlay:注册进 `shell.overlay` 的全幅层。
 * 两种打开方式,同一时刻只显示一个(资产实例优先):
 * - 连接管理(设置页只挂资产 tab):连接管理桥(inject hooks 舱位)的
 *   open 决定,来自工作区列「新建连接」与 embed 资产条「去设置添加」;
 * - 实例操作页:选择桥的 assetId / instanceId / routePrefix 决定内容。
 *   已迁移路由(renderMode native,见 sections.ts)壳内直渲 React 组件,
 *   未迁移路由仍走 embed iframe(assetInstanceUrl)。instanceId 由打开
 *   动作生成一次,渲染期只读——重渲染不会重载 iframe。
 * 关闭:右上角关闭钮 / Esc / embed 转发 Esc。
 */
import { useEffect } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  assetInstanceUrl, CONNECTION_MANAGER_TABS, renderModeForAsset, settingsEmbedUrl,
} from './sections.ts'
import type { StarHubAssetListState, ToolSelection } from './store.ts'
import { BrokerView } from './broker/BrokerView.tsx'

/** Business face injected by the registration: close/open the two overlay surfaces. */
export interface StarHubOverlayInjected {
  closeAsset: () => void
  /** 打开连接管理 overlay(embed 资产条「去设置添加」经 postMessage 触发)。 */
  openConnectionManager: () => void
  closeConnectionManager: () => void
  hooks: {
    selection: SnapshotStore<ToolSelection>
    connectionManager: SnapshotStore<{ open: boolean }>
    /** 资产列表(壳内 native 实例页按 assetId 反查资产配置)。 */
    assets: SnapshotStore<StarHubAssetListState>
  }
}

/** Full composed props: overlay runtime share + injected face. */
export type StarHubOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<StarHubOverlayInjected>

/** Message type the StarHub embed shell posts when Escape is pressed inside the iframe. */
const EMBED_ESCAPE_MESSAGE = 'starhub-embed-escape'
/** Message type the embed asset bar posts to ask the shell to open the connection manager. */
const EMBED_OPEN_SECTION_MESSAGE = 'starhub-embed-open-section'

/** 连接管理 overlay 的 iframe src(设置页只挂资产 tab)。 */
const CONNECTION_MANAGER_URL = settingsEmbedUrl(CONNECTION_MANAGER_TABS, 'assets')

/**
 * Render the full-frame StarHub overlay: the connection manager (settings
 * page, assets tab only) or an asset instance operation page, whichever is
 * active. Asset pages whose route is migrated render the native React view;
 * the rest keep the embed iframe.
 * @param props - composed slot props (injected bridges face).
 * @returns null when closed; otherwise the overlay layer.
 */
export function StarHubOverlay({
  closeAsset, openConnectionManager, closeConnectionManager, useSelection, useConnectionManager, useAssets,
}: StarHubOverlayProps) {
  const selection = useSelection(s => s)
  const managerOpen = useConnectionManager(s => s.open)
  const assets = useAssets(s => s.assets)
  const assetOpen = selection.assetId !== null && selection.instanceId !== null && selection.routePrefix !== null
  const open = assetOpen || managerOpen

  useEffect(() => {
    if (!open) return
    const close = () => {
      if (assetOpen) closeAsset()
      else closeConnectionManager()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    // iframe 聚焦时 Esc 到不了顶层 document,embed 外壳经 postMessage 转发;
    // embed 资产条的「去设置添加」也经 postMessage 请求打开连接管理
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const data = e.data as { type?: unknown; key?: unknown } | null
      if (data?.type === EMBED_ESCAPE_MESSAGE) {
        close()
      } else if (data?.type === EMBED_OPEN_SECTION_MESSAGE && data.key === 'settings') {
        openConnectionManager()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('message', onMessage)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('message', onMessage)
    }
  }, [open, assetOpen, closeAsset, openConnectionManager, closeConnectionManager])

  if (!open) return null

  // 壳内 native 分支:已迁移路由按 assetId 反查资产,直渲 React 视图。
  const openAsset = assetOpen && selection.assetId !== null
    ? assets.find((a) => a.id === selection.assetId)
    : undefined
  const native = openAsset !== undefined && renderModeForAsset(openAsset) === 'native'

  return (
    // shell.overlay 层本身 click-through,这里整幅接管指针事件
    <div style={{
      position: 'fixed', inset: 0, zIndex: 40,
      pointerEvents: 'auto', background: 'var(--dsw-background-primary, #0b0f14)',
    }}>
      {native && openAsset !== undefined ? (
        <BrokerView asset={openAsset} />
      ) : assetOpen ? (
        <iframe
          key={`asset-${selection.instanceId}`}
          title="starhub-asset"
          src={assetInstanceUrl(selection.routePrefix!, selection.instanceId!)}
          style={{ display: 'block', width: '100%', height: '100%', border: 'none' }}
        />
      ) : (
        <iframe
          key="connection-manager"
          title="starhub-connection-manager"
          src={CONNECTION_MANAGER_URL}
          style={{ display: 'block', width: '100%', height: '100%', border: 'none' }}
        />
      )}
      <button
        type="button"
        aria-label="关闭"
        onClick={() => { if (assetOpen) closeAsset(); else closeConnectionManager() }}
        style={{
          position: 'absolute', top: 8, right: 8, zIndex: 41,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, border: 'none', borderRadius: 6,
          background: 'var(--dsw-background-secondary, rgba(20,26,34,0.85))',
          color: 'var(--dsw-foreground-secondary, #9aa7b4)', cursor: 'pointer',
        }}
      >
        <IconCloseOutline16 size={14} />
      </button>
    </div>
  )
}
