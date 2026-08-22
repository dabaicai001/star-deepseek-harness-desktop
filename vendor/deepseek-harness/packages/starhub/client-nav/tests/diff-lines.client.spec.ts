import { describe, expect, it } from 'vitest'
import { diffLines } from '../src/client/file-viewer/diff-lines.ts'

const changed = (flags: readonly boolean[]): number[] =>
  flags.flatMap((flag, index) => (flag ? [index] : []))

describe('diffLines', () => {
  it('flags only the changed lines inside a hunk', () => {
    const { before, after } = diffLines('keep\nold line\nkeep too', 'keep\nnew line\nkeep too')
    expect(changed(before)).toEqual([1])
    expect(changed(after)).toEqual([1])
  })

  it('flags pure insertions on the after side only', () => {
    const { before, after } = diffLines('a\nc', 'a\nb\nc')
    expect(changed(before)).toEqual([])
    expect(changed(after)).toEqual([1])
  })

  it('flags pure removals on the before side only', () => {
    const { before, after } = diffLines('a\nb\nc', 'a\nc')
    expect(changed(before)).toEqual([1])
    expect(changed(after)).toEqual([])
  })

  it('flags every line of a newly created file as added', () => {
    const { before, after } = diffLines('', 'one\ntwo')
    expect(changed(before)).toEqual([])
    expect(changed(after)).toEqual([0, 1])
  })

  it('flags every line of a cleared hunk as removed', () => {
    const { before, after } = diffLines('one\ntwo', '')
    expect(changed(before)).toEqual([0, 1])
    expect(changed(after)).toEqual([])
  })

  it('flags a replacement where neither side shares middle lines', () => {
    const { before, after } = diffLines('x\ny', 'p\nq\nr')
    expect(changed(before)).toEqual([0, 1])
    expect(changed(after)).toEqual([0, 1, 2])
  })

  it('falls back to all-changed for a pathological middle instead of a quadratic table', () => {
    const oldLines = Array.from({ length: 600 }, (_, i) => `old ${i}`).join('\n')
    const newLines = Array.from({ length: 600 }, (_, i) => `new ${i}`).join('\n')
    const { before, after } = diffLines(oldLines, newLines)
    expect(changed(before)).toHaveLength(600)
    expect(changed(after)).toHaveLength(600)
  })
})
