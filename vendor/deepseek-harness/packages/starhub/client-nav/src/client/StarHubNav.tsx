/**
 * StarHub 侧栏导航:注册进 `sidebar.navigation` 的功能页条目列表。
 * 纯展示组件:激活态与切换动作全部来自 PropsStore 共享(nav store 与
 * overlay 层同一份 handle)。
 */
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.navigation' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { STARHUB_SECTIONS } from './sections.ts'
import type { createStarHubNavStore } from './store.ts'

/** Full composed props: navigation owner share + the shared nav store share. */
export type StarHubNavProps =
  & PropsRuntime<'sidebar.navigation'>
  & PropsStore<ReturnType<typeof createStarHubNavStore>>

const rowStyle = (active: boolean, wide: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: wide ? 'flex-start' : 'center',
  gap: wide ? 8 : 0,
  width: wide ? '100%' : 36,
  height: wide ? undefined : 36,
  padding: wide ? '4px 8px' : 0,
  border: 'none',
  borderRadius: 6,
  background: active ? 'var(--dsw-background-secondary, rgba(255,255,255,0.08))' : 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
})

/** 分组标题(仅在展开态显示,rail 只有图标)。 */
const headerStyle: React.CSSProperties = {
  alignSelf: 'stretch',
  padding: '0 8px 4px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--dsw-foreground-secondary, #9aa7b4)',
}

/**
 * Render the StarHub section rows pinned at the top of the sidebar.
 * @param props - composed slot props (owner `wide` flag + nav store share).
 * @returns the rows element tree.
 */
export function StarHubNav({ wide, useStore, actions }: StarHubNavProps) {
  const active = useStore(s => s.active)
  return (
    <>
      {wide && <div style={headerStyle}>工具</div>}
      {STARHUB_SECTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          style={rowStyle(active === key, wide)}
          title={label}
          aria-pressed={active === key}
          onClick={() => actions.toggleSection(key)}
        >
          <Icon size={wide ? 16 : 18} />
          {wide ? <span>{label}</span> : null}
        </button>
      ))}
    </>
  )
}
