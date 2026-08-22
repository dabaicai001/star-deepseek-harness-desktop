// ProducedFiles: the produced-file row a finished turn ends with. The paths
// come pre-matched by the turn-tail chain from the mutation tools'
// follow-along locations/diffs, never from the closing prose. Clicking one
// prefers the in-app viewer (viewFile, same as the tool rows) and falls back
// to the Host's own opener on the Host machine when the viewer service is
// absent. The measured chip lane shows a fitting prefix; the remainder count
// expands into the full list (every produced file with its change shape:
// 新增/修改 tag and +/- line estimate from the call's diff).

import { useLayoutEffect, useRef, useState } from 'react'
import type { HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { basename, type ProducedEntry } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import css from './ProducedFiles.module.css'

/** At most six chips compete for the one-line summary; every other path stays counted. */
const SHOWN_LIMIT = 6

/**
 * Select the largest prefix whose measured chips and exact remainder fit.
 * @param available - usable width of the one-line file lane.
 * @param gap - computed flex gap between adjacent visible items.
 * @param chipWidths - measured widths for the candidate file chips.
 * @param moreWidthsByShown - exact localized remainder width for each shown count.
 * @returns Number of leading chips to render.
 */
export function fitProducedFiles(
  available: number,
  gap: number,
  chipWidths: readonly number[],
  moreWidthsByShown: readonly (number | undefined)[],
): number {
  if (available <= 0) return chipWidths.length
  const prefix = [0]
  let prefixWidth = 0
  for (const width of chipWidths) {
    prefixWidth += width
    prefix.push(prefixWidth)
  }
  let largestFit = 0
  for (const [shown, width] of prefix.entries()) {
    const more = moreWidthsByShown[shown]
    const items = shown + (more === undefined ? 0 : 1)
    const needed = width + (more ?? 0) + Math.max(0, items - 1) * gap
    if (needed <= available) largestFit = shown
  }
  return largestFit
}

/** Registration-side Host capability facts. */
export interface ProducedFilesInjected {
  /** Whether the browser itself is connected over loopback. */
  isLoopback: boolean
  hooks: {
    /** Current generation's Host description, bound by the slot renderer. */
    hostDescription: HostDescriptionSource
  }
}

/** Matched entries plus the openers, locale, and injected Host capability. */
export type ProducedFilesProps = Pick<TurnTailOwnerProps, 'openFile' | 'viewFile'> & {
  matched: readonly ProducedEntry[]
} & PropsLocale<typeof NS> & InjectFace<ProducedFilesInjected>

function moreLabel(t: ProducedFilesProps['t'], count: number): string {
  return count === 1 ? t('produced.moreOne') : t('produced.more', { count: String(count) })
}

/** +/- line estimate shared by the chips and the expanded list; omitted when unknown. */
function Stats({ entry }: { entry: ProducedEntry }) {
  if (entry.added === 0 && entry.removed === 0) return null
  return (
    <span className={css.stats}>
      <span className={css.add}>+{entry.added}</span>
      <span className={css.del}>-{entry.removed}</span>
    </span>
  )
}

/** Chip body: basename plus the diff estimate; probes measure this exact content. */
function ChipContent({ entry }: { entry: ProducedEntry }) {
  return (
    <>
      {basename(entry.path)}
      <Stats entry={entry} />
    </>
  )
}

/**
 * Render one turn's produced files as openable chips.
 * @param props - selector-matched entries, the chat view's file openers, and the locale seat.
 * @returns The produced-files row.
 */
export function ProducedFiles({
  matched: entries, openFile, viewFile, isLoopback, useHostDescription, t,
}: ProducedFilesProps) {
  const hostCanOpenPath = useHostDescription(description => description?.canOpenPath === true)
  const canOpenPath = isLoopback && hostCanOpenPath
  // 壳内查看窗优先(与工具行一致);查看服务缺失(plain dsh web)时退回 OS 打开。
  const open = viewFile !== undefined
    ? (path: string) => { viewFile({ kind: 'read', path }) }
    : openFile
  const limit = Math.min(entries.length, SHOWN_LIMIT)
  const [shownCount, setShownCount] = useState(limit)
  const [expanded, setExpanded] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const chipProbes = useRef<Array<HTMLButtonElement | null>>([])
  const moreProbe = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const row = rowRef.current
    const remainderProbe = moreProbe.current
    /* v8 ignore next -- React attaches both refs before the layout effect runs. */
    if (row === null || remainderProbe === null) return
    const measure = (): void => {
      const styles = getComputedStyle(row)
      const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0
      // React attaches every still-mounted callback ref before layout effects run.
      const activeChipProbes = chipProbes.current.slice(0, limit) as HTMLButtonElement[]
      const chips = activeChipProbes.map(probe => probe.getBoundingClientRect().width)
      const more = Array.from({ length: limit + 1 }, (_, candidate) => {
        if (entries.length === candidate) return undefined
        remainderProbe.textContent = moreLabel(t, entries.length - candidate)
        return remainderProbe.getBoundingClientRect().width
      })
      setShownCount(fitProducedFiles(row.clientWidth, gap, chips, more))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    for (const probe of [...chipProbes.current, moreProbe.current]) {
      if (probe !== null) observer.observe(probe)
    }
    return () => { observer.disconnect() }
  }, [limit, entries, t])

  const visibleCount = Math.min(shownCount, limit)
  const shown = entries.slice(0, visibleCount)
  const hidden = entries.length - shown.length
  return (
    <div className={css.root}>
      <span className={css.label}>{t('produced.label')}</span>
      <div ref={rowRef} className={css.row} data-produced-files-row>
        {shown.map(entry => (
          <button
            key={entry.path}
            type="button"
            className={css.file}
            // The full path is the disambiguator when two turns produce files
            // that share a basename; the chip itself stays short.
            title={entry.path}
            aria-label={t('produced.open', { name: entry.path })}
            onClick={() => { open(entry.path) }}
          >
            <ChipContent entry={entry} />
          </button>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            className={css.more}
            aria-expanded={expanded}
            title={t('produced.expand', { count: String(entries.length) })}
            onClick={() => { setExpanded(value => !value) }}
          >
            {moreLabel(t, hidden)}
          </button>
        )}
      </div>
      {hidden > 0 && canOpenPath && (
        <button type="button" className={css.showFolder} onClick={() => { openFile('.') }}>
          {t('produced.showInFolder')}
        </button>
      )}
      {expanded && (
        <div className={css.list} data-produced-files-list>
          <div className={css.listHead}>
            <span>{t('produced.listTitle', { count: String(entries.length) })}</span>
            <button type="button" className={css.collapse} onClick={() => { setExpanded(false) }}>
              {t('produced.collapse')}
            </button>
          </div>
          {entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              className={css.listRow}
              aria-label={t('produced.open', { name: entry.path })}
              onClick={() => { open(entry.path) }}
            >
              <span className={entry.created ? css.tagCreated : css.tagModified}>
                {entry.created ? t('produced.created') : t('produced.modified')}
              </span>
              <span className={css.listPath}>{entry.path}</span>
              <Stats entry={entry} />
            </button>
          ))}
        </div>
      )}
      <div className={css.measure} aria-hidden="true">
        {entries.slice(0, limit).map((entry, index) => (
          <button
            key={entry.path}
            ref={(node) => { chipProbes.current[index] = node }}
            type="button"
            tabIndex={-1}
            className={`${css.file} ${css.probe}`}
          >
            <ChipContent entry={entry} />
          </button>
        ))}
        <button ref={moreProbe} type="button" tabIndex={-1} className={`${css.more} ${css.probe}`} />
      </div>
    </div>
  )
}
