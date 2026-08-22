/**
 * Line-level intra-hunk diff for the file viewer's edit mode. Each hunk's
 * oldText/newText pair is compared line by line so only the genuinely changed
 * lines take the red/green +/- blocks; lines both sides share stay plain.
 * @module client-nav/src/client/file-viewer/diff-lines
 */

/** Which lines of one side changed: true marks a removed (before) or added (after) line. */
export interface LineDiffFlags {
  readonly before: readonly boolean[]
  readonly after: readonly boolean[]
}

/**
 * Middle segments larger than this many line pairs fall back to marking every
 * middle line changed — the exact LCS table would cost quadratic memory on
 * pathological hunks (e.g. a full-file rewrite), while a coarser highlight is
 * still truthful there.
 */
const EXACT_CELL_LIMIT = 200_000

/**
 * Compare two hunk texts line by line.
 * @param oldText - the hunk's prior text ('' for a newly created file).
 * @param newText - the hunk's replacement text.
 * @returns Per-line changed flags for both columns.
 */
export function diffLines(oldText: string, newText: string): LineDiffFlags {
  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')
  const before = new Array<boolean>(oldLines.length).fill(false)
  const after = new Array<boolean>(newLines.length).fill(false)

  // Common prefix/suffix lines are unchanged; only the differing middle needs
  // the (potentially quadratic) exact comparison.
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let oldTail = oldLines.length
  let newTail = newLines.length
  while (oldTail > head && newTail > head && oldLines[oldTail - 1] === newLines[newTail - 1]) {
    oldTail--
    newTail--
  }

  const midOld = oldLines.slice(head, oldTail)
  const midNew = newLines.slice(head, newTail)
  if (midOld.length * midNew.length > EXACT_CELL_LIMIT) {
    before.fill(true, head, oldTail)
    after.fill(true, head, newTail)
    return { before, after }
  }

  // LCS over the middle: matched lines stay plain, the rest are the change.
  // (noUncheckedIndexedAccess also applies to typed arrays — the `?? 0` arms
  // are statically required, the table is dense by construction.)
  const width = midNew.length + 1
  const table = new Uint32Array((midOld.length + 1) * width)
  const cell = (i: number, j: number): number => table[i * width + j] ?? 0
  for (let i = midOld.length - 1; i >= 0; i--) {
    for (let j = midNew.length - 1; j >= 0; j--) {
      table[i * width + j] = midOld[i] === midNew[j]
        ? cell(i + 1, j + 1) + 1
        : Math.max(cell(i + 1, j), cell(i, j + 1))
    }
  }
  let i = 0
  let j = 0
  while (i < midOld.length && j < midNew.length) {
    if (midOld[i] === midNew[j]) {
      i++
      j++
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      before[head + i] = true
      i++
    } else {
      after[head + j] = true
      j++
    }
  }
  before.fill(true, head + i, oldTail)
  after.fill(true, head + j, newTail)
  return { before, after }
}
