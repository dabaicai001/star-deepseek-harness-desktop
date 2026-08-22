// Shared +/- line estimate badge: rendered by the summary chips and by the
// drawer's file rows. The classes live in ProducedFiles.module.css so chips
// and rows share one source.

import type { ProducedEntry } from './turn-deliverables.ts'
import css from './ProducedFiles.module.css'

/**
 * +/- line estimate shared by the chips and the drawer rows; omitted when
 * the call's diff declared no line counts.
 * @param props.entry - the produced file whose estimate renders.
 * @returns The badge pair, or null when both counts are zero.
 */
export function Stats({ entry }: { entry: ProducedEntry }) {
  if (entry.added === 0 && entry.removed === 0) return null
  return (
    <span className={css.stats}>
      <span className={css.add}>+{entry.added}</span>
      <span className={css.del}>-{entry.removed}</span>
    </span>
  )
}
