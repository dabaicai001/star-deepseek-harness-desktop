/**
 * 右键菜单共享胶水(StarHub 本地包,规则从简):把 dsh 的 Menu 原语接到
 * 行/条的 onContextMenu 上。右键位置经 portal + getAnchorRect 固定成
 * 指针处的零面积矩形,anchor 只占位、不参与交互;项点击由调用方在
 * onSelect 里分发,ContextMenu 负责分发后关闭。样式与 dsh 现有 hover
 * 菜单完全一致(同一 Menu 原语)。
 */
import { useState } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

/** 一次右键的指针位置;null = 菜单关闭。 */
export interface ContextMenuPosition {
  x: number
  y: number
}

/** 单个行/条的右键菜单状态与接线。 */
export interface ContextMenuState {
  /** 菜单是否打开。 */
  open: boolean
  /** 行上右键:阻止浏览器原生菜单并记录指针位置。 */
  onContextMenu: (e: { preventDefault: () => void; clientX: number; clientY: number }) => void
  /** 关闭菜单(选择后由 ContextMenu 调用)。 */
  close: () => void
  /** Menu portal 的固定锚点(指针位置处的零面积矩形)。 */
  getAnchorRect: () => DOMRect | null
}

/**
 * Create one row's right-click menu state.
 * @returns the state handle consumed by a ContextMenu render.
 */
export function useContextMenu(): ContextMenuState {
  const [position, setPosition] = useState<ContextMenuPosition | null>(null)
  return {
    open: position !== null,
    onContextMenu: (e) => {
      e.preventDefault()
      setPosition({ x: e.clientX, y: e.clientY })
    },
    close: () => { setPosition(null) },
    getAnchorRect: () => position === null
      ? null
      : ({ left: position.x, top: position.y, right: position.x, bottom: position.y, width: 0, height: 0 } as DOMRect),
  }
}

/**
 * Render a right-click menu anchored at the stored pointer position.
 * @param props.menu - the row's context-menu state (useContextMenu).
 * @param props.items - menu rows (dsh MenuEntry,支持 separator / danger / disabled)。
 * @param props.onSelect - item click dispatch; the menu closes itself after it.
 * @param props.className - wrapper class (callers pass `display: contents` so
 * the empty anchor span never affects the row layout)。
 * @returns the Menu primitive wired for right-click anchoring.
 */
export function ContextMenu({ menu, items, onSelect, className }: {
  menu: ContextMenuState
  items: readonly MenuEntry[]
  onSelect: (id: string) => void
  className: string | undefined
}) {
  return (
    <Menu
      open={menu.open}
      onClose={menu.close}
      items={items}
      onSelect={(id) => { menu.close(); onSelect(id) }}
      portal
      getAnchorRect={menu.getAnchorRect}
      {...(className === undefined ? {} : { className })}
      anchor={<span aria-hidden="true" />}
    />
  )
}
