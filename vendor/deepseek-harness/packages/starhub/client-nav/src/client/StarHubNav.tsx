/**
 * StarHub 侧栏导航(方案 P1):「工具」大类(可展开)下挂子类行。
 * 纯展示组件:展开态、选中子类、激活态与切换动作全部来自 PropsStore 共享
 * (nav store 与右侧列、overlay 层同一份 handle);点子类经 inject 回调打开
 * 右侧工具工作区列。
 */
import type { PropsRuntime, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.navigation' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconChevronDownOutline14, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SUBCATEGORIES, STARHUB_SECTIONS } from './sections.ts'
import type { createStarHubStore } from './store.ts'

/** Business face injected by the registration: open the docked tool workspace. */
export interface StarHubNavInjected {
  openWorkspace: () => void
}

/** Full composed props: navigation owner share + the shared StarHub store share + injected face. */
export type StarHubNavProps =
  & PropsRuntime<'sidebar.navigation'>
  & PropsStore<ReturnType<typeof createStarHubStore>>
  & InjectFace<StarHubNavInjected>

const rowStyle = (active: boolean, wide: boolean, indent = false): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: wide ? 'flex-start' : 'center',
  gap: wide ? 8 : 0,
  width: wide ? '100%' : 36,
  height: wide ? undefined : 36,
  padding: wide ? (indent ? '4px 8px 4px 20px' : '4px 8px') : 0,
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
 * Render the StarHub sidebar navigation: the expandable "工具" category with
 * subcategory rows (terminal / database / docker), plus legacy flat entries.
 * @param props - composed slot props (owner `wide` flag + nav store share + injected workspace opener).
 * @returns the rows element tree.
 */
export function StarHubNav({ wide, useStore, actions, openWorkspace }: StarHubNavProps) {
  const categoryOpen = useStore(s => s.categoryOpen)
  const activeSubcategory = useStore(s => s.activeSubcategory)
  const active = useStore(s => s.active)
  return (
    <>
      {wide && <div style={headerStyle}>工具</div>}
      <button
        key="starhub-category"
        type="button"
        style={rowStyle(false, wide)}
        title="工具"
        aria-expanded={categoryOpen || undefined}
        onClick={() => actions.toggleCategory()}
      >
        <IconDataOutline16 size={wide ? 16 : 18} />
        {wide
          ? (
            <>
              <span style={{ flex: 1 }}>工具</span>
              <IconChevronDownOutline14
                size={12}
                // Chevron points right when collapsed (rotate when open).
              />
            </>
          )
          : null}
      </button>
      {categoryOpen && STARHUB_SUBCATEGORIES.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          style={rowStyle(activeSubcategory === key, wide, true)}
          title={label}
          aria-pressed={activeSubcategory === key}
          onClick={() => {
            actions.setSubcategory(key)
            openWorkspace()
          }}
        >
          <Icon size={wide ? 15 : 17} />
          {wide ? <span>{label}</span> : null}
        </button>
      ))}
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
