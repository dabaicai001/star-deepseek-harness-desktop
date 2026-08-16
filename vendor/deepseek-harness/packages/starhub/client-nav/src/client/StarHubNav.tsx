/**
 * StarHub 侧栏导航(方案 P1):「工具」大类(可展开)下挂子类行。
 * 大类展开态与旧扁平条目来自 root scope 的 nav store;子类选中态跨 scope
 * (工作区列在 session-maybe scope),经 inject hooks 舱位的 useSelection
 * 读取,点击经 selectSubcategory 回调写入选择桥并开/关右侧工作区列。
 */
import type { PropsRuntime, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.navigation' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SUBCATEGORIES, STARHUB_SECTIONS } from './sections.ts'
import type { createStarHubNavStore, ToolSelection } from './store.ts'

/** Business face injected by the registration: subcategory selection (bridge write + workspace toggle). */
export interface StarHubNavInjected {
  selectSubcategory: (key: string) => void
  hooks: { selection: SnapshotStore<ToolSelection> }
}

/** Full composed props: navigation owner share + the root nav store share + injected face. */
export type StarHubNavProps =
  & PropsRuntime<'sidebar.navigation'>
  & PropsStore<ReturnType<typeof createStarHubNavStore>>
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
 * @param props - composed slot props (owner `wide` flag + nav store share + injected selection face).
 * @returns the rows element tree.
 */
export function StarHubNav({ wide, useStore, actions, selectSubcategory, useSelection }: StarHubNavProps) {
  const categoryOpen = useStore(s => s.categoryOpen)
  const active = useStore(s => s.active)
  const activeSubcategory = useSelection(s => s.subcategory)
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
          onClick={() => selectSubcategory(key)}
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
