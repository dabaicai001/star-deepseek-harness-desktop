// @vitest-environment jsdom
/**
 * ProducedFilesDrawer component behavior: 新增/修改 grouping, row openers,
 * the three close paths (Escape / mask / ×), section folding, the optional
 * native-folder footer, and the modal focus discipline.
 */
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ProducedEntry } from '../src/client/turn-deliverables.ts'
import { ProducedFilesDrawer } from '../src/client/ProducedFilesDrawer.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)

afterEach(() => {
  cleanup()
})

/** One produced entry (defaults: modified, no line estimate). */
const entryOf = (path: string, over?: Partial<ProducedEntry>): ProducedEntry => ({
  seq: 1, path, created: false, added: 0, removed: 0, ...over,
})

function drawerOf(view: ReturnType<typeof render>): HTMLElement {
  const drawer = view.container.querySelector('[data-produced-files-drawer]')
  if (!(drawer instanceof HTMLElement)) throw new Error('produced drawer missing')
  return drawer
}

describe('ProducedFilesDrawer', () => {
  it('declines to mount for the unreachable empty case', () => {
    const view = render(
      <ProducedFilesDrawer entries={[]} open={() => {}} onClose={() => {}} t={t} />,
    )
    expect(view.container.querySelector('[data-produced-files-drawer]')).toBeNull()
  })

  it('groups rows into 新增 then 修改 with per-section counts and stats', () => {
    const entries = [
      entryOf('src/api.ts', { added: 8, removed: 2 }),
      entryOf('src/new-page.tsx', { created: true, added: 120 }),
      entryOf('src/util.ts'),
      entryOf('src/another.ts', { created: true }),
    ]
    const open = vi.fn<(path: string) => void>()
    const view = render(
      <ProducedFilesDrawer entries={entries} open={open} onClose={() => {}} t={t} />,
    )
    const drawer = drawerOf(view)
    expect(within(drawer).getByText('本轮改动文件(共 4 个)')).toBeTruthy()
    // 新增 section comes first and keeps first-seen order inside the group.
    const heads = within(drawer).getAllByRole('button', { name: /^(新增|修改)\(/ })
    expect(heads.map(head => head.textContent)).toEqual(['▾新增(2)', '▾修改(2)'])
    const rows = within(drawer).getAllByRole('button', { name: /^打开 / })
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual([
      '打开 src/new-page.tsx', '打开 src/another.ts', '打开 src/api.ts', '打开 src/util.ts',
    ])
    expect(within(drawer).getByText('+120')).toBeTruthy()
    expect(within(drawer).getByText('+8')).toBeTruthy()
    expect(within(drawer).getByText('-2')).toBeTruthy()
    // Row clicks go through the same opener as the chips, path intact.
    fireEvent.click(within(drawer).getByRole('button', { name: '打开 src/api.ts' }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('src/api.ts')
  })

  it('hides a section whose group is empty', () => {
    const only = render(
      <ProducedFilesDrawer
        entries={[entryOf('a.ts', { created: true })]}
        open={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    expect(within(drawerOf(only)).queryByText(/^修改\(/)).toBeNull()
    expect(within(drawerOf(only)).getByText(/^新增\(1\)/)).toBeTruthy()
    only.unmount()
    const rest = render(
      <ProducedFilesDrawer entries={[entryOf('b.ts')]} open={() => {}} onClose={() => {}} t={t} />,
    )
    expect(within(drawerOf(rest)).queryByText(/^新增\(/)).toBeNull()
    expect(within(drawerOf(rest)).getByText(/^修改\(1\)/)).toBeTruthy()
  })

  it('closes on Escape, on mask click, and on the × button', () => {
    const onClose = vi.fn<() => void>()
    const view = render(
      <ProducedFilesDrawer entries={[entryOf('a.ts')]} open={() => {}} onClose={onClose} t={t} />,
    )
    // Non-Escape keys do not close.
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    // The mask is the panel's sibling presentation layer (css-modules renames
    // the class, so resolve it structurally: root → mask → panel).
    const mask = view.container.firstChild?.firstChild
    if (!(mask instanceof HTMLElement)) throw new Error('drawer mask missing')
    fireEvent.click(mask)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(within(drawerOf(view)).getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('folds and re-expands a section from its header', () => {
    const view = render(
      <ProducedFilesDrawer
        entries={[entryOf('a.ts', { created: true }), entryOf('b.ts')]}
        open={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    const drawer = drawerOf(view)
    const created = within(drawer).getByRole('button', { name: /^新增\(1\)/ })
    expect(created.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(created)
    expect(created.getAttribute('aria-expanded')).toBe('false')
    expect(within(drawer).queryByRole('button', { name: '打开 a.ts' })).toBeNull()
    expect(within(drawer).getByRole('button', { name: '打开 b.ts' })).toBeTruthy()
    // The other section stays expanded; re-clicking restores the rows.
    const modified = within(drawer).getByRole('button', { name: /^修改\(1\)/ })
    fireEvent.click(modified)
    expect(within(drawer).queryByRole('button', { name: '打开 b.ts' })).toBeNull()
    fireEvent.click(modified)
    expect(within(drawer).getByRole('button', { name: '打开 b.ts' })).toBeTruthy()
  })

  it('shows the folder footer only when the host supplies it', () => {
    const showInFolder = vi.fn<() => void>()
    const withFooter = render(
      <ProducedFilesDrawer
        entries={[entryOf('a.ts')]}
        open={() => {}}
        showInFolder={showInFolder}
        onClose={() => {}}
        t={t}
      />,
    )
    fireEvent.click(within(drawerOf(withFooter)).getByRole('button', { name: '在文件夹中显示' }))
    expect(showInFolder).toHaveBeenCalledTimes(1)
    withFooter.unmount()
    const without = render(
      <ProducedFilesDrawer entries={[entryOf('a.ts')]} open={() => {}} onClose={() => {}} t={t} />,
    )
    expect(within(drawerOf(without)).queryByRole('button', { name: '在文件夹中显示' })).toBeNull()
  })

  it('moves focus to the close button on open and cycles Tab inside the panel', () => {
    const view = render(
      <ProducedFilesDrawer
        entries={[entryOf('a.ts'), entryOf('b.ts')]}
        open={() => {}}
        onClose={() => {}}
        t={t}
      />,
    )
    const drawer = drawerOf(view)
    const close = within(drawer).getByRole('button', { name: '关闭' })
    expect(document.activeElement).toBe(close)

    const buttons = Array.from(drawer.querySelectorAll('button'))
    const last = buttons[buttons.length - 1]!
    // Tab on the last button wraps to the first.
    last.focus()
    fireEvent.keyDown(drawer, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    // Shift+Tab on the first wraps to the last.
    close.focus()
    fireEvent.keyDown(drawer, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    // Tab on a middle button keeps the browser default (no wrap).
    const middle = buttons[1]!
    middle.focus()
    fireEvent.keyDown(drawer, { key: 'Tab' })
    expect(document.activeElement).toBe(middle)
    // Non-Tab keys pass through untouched.
    fireEvent.keyDown(drawer, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(middle)
  })
})
