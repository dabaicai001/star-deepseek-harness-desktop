export interface SheetRowRange {
  startRow: number
  endRow: number
}

/**
 * Convert a Univer sheet range to zero-based database row indexes.
 * Sheet row 0 is StarHub's column header and is never returned.
 */
export function dataRowIndicesFromSheetRange(
  range: SheetRowRange | null | undefined,
  rowCount: number,
): number[] {
  if (!range || rowCount <= 0) return []

  const firstSheetRow = Math.max(1, Math.min(range.startRow, range.endRow))
  const lastSheetRow = Math.min(rowCount, Math.max(range.startRow, range.endRow))
  if (firstSheetRow > lastSheetRow) return []

  return Array.from(
    { length: lastSheetRow - firstSheetRow + 1 },
    (_, offset) => firstSheetRow + offset - 1,
  )
}

/** Keep valid row indexes once and in their visual order. */
export function normalizeDataRowIndices(rowIndices: number[], rowCount: number): number[] {
  return [...new Set(rowIndices)]
    .filter(row => Number.isInteger(row) && row >= 0 && row < rowCount)
    .sort((left, right) => left - right)
}
