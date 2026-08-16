/**
 * StarHub overlay:注册进 `shell.overlay` 的全幅 iframe 层。
 * 两种打开方式,同一时刻只显示一个:
 * - 旧扁平条目(设置等):nav store 的 active 决定 src;
 * - 实例操作页(方案 P1):nav store 的 activeAssetId + 当前子类决定 src
 *   (`assetInstanceUrl`),点资产行打开,关闭按钮 / Esc / embed 转发 Esc 关闭。
 */
import { useEffect } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SECTIONS, STARHUB_SUBCATEGORIES, assetInstanceUrl, sectionEmbedUrl } from './sections.ts'
import type { createStarHubStore } from './store.ts'

/** Full composed props: overlay runtime share + the shared StarHub store share. */
export type StarHubOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createStarHubStore>>

/** Message type the StarHub embed shell posts when Escape is pressed inside the iframe. */
const EMBED_ESCAPE_MESSAGE = 'starhub-embed-escape'
/** Message type the embed asset bar posts to ask the shell to open another section (e.g. settings). */
const EMBED_OPEN_SECTION_MESSAGE = 'starhub-embed-open-section'

/**
 * Render the full-frame StarHub overlay: a flat section (settings etc.) or an
 * asset instance operation page, whichever is active.
 * @param props - composed slot props (nav store share).
 * @returns null when closed; otherwise the overlay layer.
 */
export function StarHubOverlay({ useStore, actions }: StarHubOverlayProps) {
  const active = useStore(s => s.active)
  const activeAssetId = useStore(s => s.activeAssetId)
  const activeSubcategory = useStore(s => s.activeSubcategory)
  const section = STARHUB_SECTIONS.find(s => s.key === active)
  const subcategory = STARHUB_SUBCATEGORIES.find(s => s.key === activeSubcategory)
  const assetOpen = activeAssetId !== null && subcategory !== undefined

  useEffect(() => {
    if (section === undefined && !assetOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (assetOpen) actions.closeAsset()
        else actions.closeSection()
      }
    }
    // iframe 聚焦时 Esc 到不了顶层 document,embed 外壳经 postMessage 转发;
    // embed 资产条的「去设置添加」也经 postMessage 请求切换功能页
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const data = e.data as { type?: unknown; key?: unknown } | null
      if (data?.type === EMBED_ESCAPE_MESSAGE) {
        if (assetOpen) actions.closeAsset()
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
  }, [section, assetOpen, actions])

  const src = assetOpen
    ? assetInstanceUrl(subcategory!.routePrefix, activeAssetId!)
    : section === undefined ? null : sectionEmbedUrl(section)
  if (src === null) return null
  return (
    // shell.overlay 层本身 click-through,这里整幅接管指针事件
    <div style={{
      position: 'fixed', inset: 0, zIndex: 40,
      pointerEvents: 'auto', background: 'var(--dsw-background-primary, #0b0f14)',
    }}>
      <iframe
        key={assetOpen ? `asset-${activeAssetId}` : `section-${section!.key}`}
        title={assetOpen ? 'starhub-asset' : `starhub-${section!.key}`}
        src={src}
        style={{ display: 'block', width: '100%', height: '100%', border: 'none' }}
      />
      <button
        type="button"
        aria-label="关闭"
        onClick={() => { if (assetOpen) actions.closeAsset(); else actions.closeSection() }}
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
