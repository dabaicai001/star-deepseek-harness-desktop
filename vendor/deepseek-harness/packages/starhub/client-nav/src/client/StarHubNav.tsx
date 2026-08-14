/**
 * StarHub 侧栏导航:注册进 `sidebar.footer.action` 的功能页条目列表。
 * 纯展示组件:激活态与切换动作全部来自 PropsStore 共享(nav store 与
 * overlay 层同一份 handle)。
 */
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.footer.action' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { STARHUB_SECTIONS } from './sections.ts'
import type { createStarHubNavStore } from './store.ts'

/** Full composed props: footer-action owner share + the shared nav store share. */
export type StarHubNavProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createStarHubNavStore>>

const rowStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '4px 8px',
  border: 'none',
  borderRadius: 6,
  background: active ? 'var(--dsw-background-secondary, rgba(255,255,255,0.08))' : 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
})

/**
 * Render the StarHub section rows at the sidebar foot.
 * @param props - composed slot props (owner `wide` flag + nav store share).
 * @returns the rows element tree.
 */
export function StarHubNav({ wide, useStore, actions }: StarHubNavProps) {
  const active = useStore(s => s.active)
  return (
    <>
      {STARHUB_SECTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          style={rowStyle(active === key)}
          title={label}
          aria-pressed={active === key}
          onClick={() => actions.toggleSection(key)}
        >
          <Icon size={16} />
          {wide ? <span>{label}</span> : null}
        </button>
      ))}
    </>
  )
}
