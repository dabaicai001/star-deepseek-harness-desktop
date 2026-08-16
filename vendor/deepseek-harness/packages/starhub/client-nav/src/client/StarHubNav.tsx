/**
 * StarHub 侧栏导航(方案 P1,重构版):「工具」大类行即分组头(图标 +
 * 文案 + 随展开态旋转的 chevron),下挂缩进的子类行(终端 / 数据库 /
 * Docker)。大类展开态来自 root scope 的 nav store;子类选中态跨 scope
 * (工作区列在 session-maybe scope),经 inject hooks 舱位的 useSelection
 * 读取,点击经 selectSubcategory 回调写入选择桥并开/关右侧工作区列。
 * Excel 与设置不再是侧栏条目:Excel 功能从导航退役;设置融入 dsh 底部
 * 设置面板(settings.section 的 StarHub 分区)。
 */
import type { PropsRuntime, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'sidebar.navigation' SlotMap row (declared by ui-sidebar).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { STARHUB_SUBCATEGORIES } from './sections.ts'
import type { createStarHubNavStore, ToolSelection } from './store.ts'
import css from './StarHubNav.module.css'

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

/**
 * Render the StarHub sidebar navigation: the collapsible "工具" category row
 * with subcategory rows (terminal / database / docker) nested underneath.
 * @param props - composed slot props (owner `wide` flag + nav store share + injected selection face).
 * @returns the rows element tree.
 */
export function StarHubNav({ wide, useStore, actions, selectSubcategory, useSelection }: StarHubNavProps) {
  const categoryOpen = useStore(s => s.categoryOpen)
  const activeSubcategory = useSelection(s => s.subcategory)
  return (
    <>
      <button
        type="button"
        className={`${css.category} ${wide ? '' : css.rail}`}
        title="工具"
        aria-expanded={categoryOpen}
        onClick={() => actions.toggleCategory()}
      >
        <IconDataOutline16 size={wide ? 15 : 18} />
        {wide
          ? (
            <>
              <span className={css.categoryLabel}>工具</span>
              <span className={`${css.chevron} ${categoryOpen ? css.open : ''}`}>
                <IconChevronDownOutline14 size={12} />
              </span>
            </>
          )
          : null}
      </button>
      {categoryOpen && STARHUB_SUBCATEGORIES.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          className={`${css.sub} ${activeSubcategory === key ? css.active : ''} ${wide ? '' : css.rail}`}
          title={label}
          aria-pressed={activeSubcategory === key}
          onClick={() => selectSubcategory(key)}
        >
          <Icon size={wide ? 14 : 16} />
          {wide ? <span className={css.subLabel}>{label}</span> : null}
        </button>
      ))}
    </>
  )
}
