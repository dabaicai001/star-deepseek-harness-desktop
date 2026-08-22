// ProducedFilesDrawer: the right-edge panel the 「+ N 个文件」remainder button
// opens. It lists every file the turn produced, grouped into 新增/修改
// sections, and replaces the v0.91.0 inline expansion (removed in v0.92.1
// after product feedback). The drawer is ProducedFiles-local UI: pure props,
// no slot, no portal — a fixed layer above the chat flow and below the global
// toast/dialog layers.

import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ProducedEntry } from './turn-deliverables.ts'
import type { ProducedFilesProps } from './ProducedFiles.tsx'
import { Stats } from './ProducedStats.tsx'
import css from './ProducedFilesDrawer.module.css'

/** Pure drawer props: entries plus the openers, the close callback, and the locale seat. */
export interface ProducedFilesDrawerProps {
  /** Every file the turn produced, in first-seen order. */
  readonly entries: readonly ProducedEntry[]
  /** The chips' viewer-first opener. */
  readonly open: (path: string) => void
  /** Native-folder action; passed only when the loopback Host can open paths. */
  readonly showInFolder?: (() => void) | undefined
  /** Close request (Escape, mask click, × button); the owner returns focus. */
  readonly onClose: () => void
  /** The `deliverables` namespace translate seat, threaded from ProducedFiles. */
  readonly t: ProducedFilesProps['t']
}

/**
 * Render the changed-files drawer. Both groups empty cannot occur through the
 * 「+ N 个文件」entry (it requires a hidden remainder), but the drawer still
 * declines to mount rather than showing an empty panel.
 * @param props - see {@link ProducedFilesDrawerProps}.
 * @returns The overlay tree, or null for the unreachable empty case.
 */
export function ProducedFilesDrawer({
  entries, open, showInFolder, onClose, t,
}: ProducedFilesDrawerProps) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [collapsed, setCollapsed] = useState({ created: false, modified: false })

  // Focus lands on the close button; the owner returns it to the remainder
  // button when the drawer unmounts.
  useEffect(() => {
    /* v8 ignore next -- React attaches the ref before the effect runs. */
    closeRef.current?.focus()
  }, [])

  // Escape closes from anywhere (the mask can take focus); Tab cycles inside
  // the panel because the layer is modal.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  /** Keep Tab focus cycling among the panel's buttons (modal layer semantics). */
  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    const buttons = event.currentTarget.querySelectorAll('button')
    /* v8 ignore next -- the close button always renders, so the set is never empty. */
    if (buttons.length === 0) return
    // NodeList.item() is null-safe by design; both ends exist given the check above.
    const first = buttons.item(0)
    const last = buttons.item(buttons.length - 1)
    const wrap = event.shiftKey
      ? document.activeElement === first
      : document.activeElement === last
    if (!wrap) return
    event.preventDefault()
    const target = event.shiftKey ? last : first
    target.focus()
  }

  const created = entries.filter(entry => entry.created)
  const modified = entries.filter(entry => !entry.created)
  if (entries.length === 0) return null

  /** One collapsible 新增/修改 section with its file rows. */
  const section = (
    kind: 'created' | 'modified',
    label: string,
    rows: readonly ProducedEntry[],
  ) => (
    <div className={css.section}>
      <button
        type="button"
        className={css.sectionHead}
        aria-expanded={!collapsed[kind]}
        onClick={() => { setCollapsed(current => ({ ...current, [kind]: !current[kind] })) }}
      >
        <span className={css.chevron} aria-hidden="true">{collapsed[kind] ? '▸' : '▾'}</span>
        {label}
      </button>
      {!collapsed[kind] && rows.map(entry => (
        <button
          key={entry.path}
          type="button"
          className={css.row}
          title={entry.path}
          aria-label={t('produced.open', { name: entry.path })}
          onClick={() => { open(entry.path) }}
        >
          <span className={css.path}>{entry.path}</span>
          <Stats entry={entry} />
        </button>
      ))}
    </div>
  )

  return (
    <div className={css.root}>
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        className={css.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        data-produced-files-drawer
      >
        <div className={css.header}>
          <h2 id={titleId} className={css.title}>
            {t('produced.drawerTitle', { count: String(entries.length) })}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className={css.close}
            aria-label={t('produced.drawerClose')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className={css.body}>
          {created.length > 0 && section(
            'created', t('produced.createdSection', { count: String(created.length) }), created,
          )}
          {modified.length > 0 && section(
            'modified', t('produced.modifiedSection', { count: String(modified.length) }), modified,
          )}
        </div>
        {showInFolder !== undefined && (
          <div className={css.footer}>
            <button type="button" className={css.showFolder} onClick={showInFolder}>
              {t('produced.showInFolder')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
