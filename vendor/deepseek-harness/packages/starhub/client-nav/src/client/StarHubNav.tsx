/**
 * StarHub 侧栏导航:注册进 `sidebar.navigation` 的功能页条目列表 + Phase 0
 * (Path B) 的「StarHub 工具工作区」入口。纯展示组件:激活态与切换动作全部
 * 来自 PropsStore 共享(nav store 与 overlay 层同一份 handle),工作区入口
 * 经 inject 回调调用 `ctx.layout.openDetails()` 打开右栏停靠的工具工作区。
 */
import type { PropsRuntime, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.navigation' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SECTIONS } from './sections.ts'
import type { createStarHubNavStore } from './store.ts'

/** Business face injected by the registration: open the docked tool workspace. */
export interface StarHubNavInjected {
  openWorkspace: () => void
}

/** Full composed props: navigation owner share + the shared nav store share + injected face. */
export type StarHubNavProps =
  & PropsRuntime<'sidebar.navigation'>
  & PropsStore<ReturnType<typeof createStarHubNavStore>>
  & InjectFace<StarHubNavInjected>

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
 * @param props - composed slot props (owner `wide` flag + nav store share + injected workspace opener).
 * @returns the rows element tree.
 */
export function StarHubNav({ wide, useStore, actions, openWorkspace }: StarHubNavProps) {
  const active = useStore(s => s.active)
  return (
    <>
      {wide && <div style={headerStyle}>工具</div>}
      <button
        key="starhub-tools-entry"
        type="button"
        style={rowStyle(false, wide)}
        title="StarHub 工具工作区"
        aria-pressed={false}
        onClick={() => openWorkspace()}
      >
        <IconDataOutline16 size={wide ? 16 : 18} />
        {wide ? <span>工具工作区</span> : null}
      </button>
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
