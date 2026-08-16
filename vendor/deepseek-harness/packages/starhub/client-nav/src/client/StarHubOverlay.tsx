/**
 * StarHub overlay:注册进 `shell.overlay` 的全幅 iframe 层。
 * 两种打开方式,同一时刻只显示一个:
 * - 旧扁平条目(设置等):root scope nav store 的 active 决定 src;
 * - 实例操作页(方案 P1):选择桥(inject hooks 舱位)的 assetId / instanceId /
 *   routePrefix 决定 src(`assetInstanceUrl`),点资产行打开,关闭按钮 / Esc /
 *   embed 转发 Esc 关闭。instanceId 由打开动作生成一次,渲染期只读——
 *   重渲染不会重载 iframe。
 */
import { useEffect } from 'react'
import type { PropsRuntime, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SECTIONS, assetInstanceUrl, sectionEmbedUrl } from './sections.ts'
import type { createStarHubNavStore, ToolSelection } from './store.ts'

/** Business face injected by the registration: close the open asset instance. */
export interface StarHubOverlayInjected {
  closeAsset: () => void
  hooks: { selection: SnapshotStore<ToolSelection> }
}

/** Full composed props: overlay runtime share + the root nav store share + injected face. */
export type StarHubOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createStarHubNavStore>>
  & InjectFace<StarHubOverlayInjected>

/** Message type the StarHub embed shell posts when Escape is pressed inside the iframe. */
const EMBED_ESCAPE_MESSAGE = 'starhub-embed-escape'
/** Message type the embed asset bar posts to ask the shell to open another section (e.g. settings). */
const EMBED_OPEN_SECTION_MESSAGE = 'starhub-embed-open-section'

/**
 * Render the full-frame StarHub overlay: a flat section (settings etc.) or an
 * asset instance operation page, whichever is active.
 * @param props - composed slot props (nav store share + injected selection face).
 * @returns null when closed; otherwise the overlay layer.
 */
export function StarHubOverlay({ useStore, actions, closeAsset, useSelection }: StarHubOverlayProps) {
  const active = useStore(s => s.active)
  const selection = useSelection(s => s)
  const section = STARHUB_SECTIONS.find(s => s.key === active)
  const assetOpen = selection.assetId !== null && selection.instanceId !== null && selection.routePrefix !== null

  useEffect(() => {
    if (section === undefined && !assetOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (assetOpen) closeAsset()
        else actions.closeSection()
      }
    }
    // iframe 聚焦时 Esc 到不了顶层 document,embed 外壳经 postMessage 转发;
    // embed 资产条的「去设置添加」也经 postMessage 请求切换功能页
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const data = e.data as { type?: unknown; key?: unknown } | null
      if (data?.type === EMBED_ESCAPE_MESSAGE) {
        if (assetOpen) closeAsset()
        else actions.closeSection()
      } else if (data?.type === EMBED_OPEN_SECTION_MESSAGE
        && typeof data.key === 'string'
        && STARHUB_SECTIONS.some(s => s.key === data.key)) {
        actions.openSection(data.key)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('message', onMessage)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('message', onMessage)
    }
  }, [section, assetOpen, actions, closeAsset])

  const src = assetOpen
    ? assetInstanceUrl(selection.routePrefix!, selection.instanceId!)
    : section === undefined ? null : sectionEmbedUrl(section)
  if (src === null) return null
  return (
    // shell.overlay 层本身 click-through,这里整幅接管指针事件
    <div style={{
      position: 'fixed', inset: 0, zIndex: 40,
      pointerEvents: 'auto', background: 'var(--dsw-background-primary, #0b0f14)',
    }}>
      <iframe
        key={assetOpen ? `asset-${selection.instanceId}` : `section-${section!.key}`}
        title={assetOpen ? 'starhub-asset' : `starhub-${section!.key}`}
        src={src}
        style={{ display: 'block', width: '100%', height: '100%', border: 'none' }}
      />
      <button
        type="button"
        aria-label="关闭"
        onClick={() => { if (assetOpen) closeAsset(); else actions.closeSection() }}
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
