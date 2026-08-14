/**
 * StarHub 功能页 overlay:注册进 `shell.overlay`(ui-layout 的加法式整帧席位)
 * 的全幅 iframe 层。同一时刻只显示一个功能页——nav store 的 active 决定 src,
 * 切换条目换 key 重挂 iframe;Esc、iframe 内转发的 Esc、关闭按钮或再次点击
 * 当前条目都关闭回 dsh 对话。
 */
import { useEffect } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SECTIONS, sectionEmbedUrl } from './sections.ts'
import type { createStarHubNavStore } from './store.ts'

/** Full composed props: overlay runtime share + the shared nav store share. */
export type StarHubOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createStarHubNavStore>>

/** Message type the StarHub embed shell posts when Escape is pressed inside the iframe. */
const EMBED_ESCAPE_MESSAGE = 'starhub-embed-escape'

/**
 * Render the full-frame StarHub section iframe when a section is active.
 * @param props - composed slot props (nav store share).
 * @returns null when closed; otherwise the overlay layer.
 */
export function StarHubOverlay({ useStore, actions }: StarHubOverlayProps) {
  const active = useStore(s => s.active)
  const section = STARHUB_SECTIONS.find(s => s.key === active)

  useEffect(() => {
    if (section === undefined) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') actions.closeSection()
    }
    // iframe 聚焦时 Esc 到不了顶层 document,embed 外壳经 postMessage 转发
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin
        && (e.data as { type?: unknown } | null)?.type === EMBED_ESCAPE_MESSAGE) {
        actions.closeSection()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('message', onMessage)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('message', onMessage)
    }
  }, [section, actions])

  if (section === undefined) return null
  return (
    // shell.overlay 层本身 click-through,这里整幅接管指针事件
    <div style={{
      position: 'fixed', inset: 0, zIndex: 40,
      pointerEvents: 'auto', background: 'var(--dsw-background-primary, #0b0f14)',
    }}>
      <iframe
        key={section.key}
        title={`starhub-${section.key}`}
        src={sectionEmbedUrl(section)}
        style={{ display: 'block', width: '100%', height: '100%', border: 'none' }}
      />
      <button
        type="button"
        aria-label="关闭"
        onClick={() => actions.closeSection()}
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
