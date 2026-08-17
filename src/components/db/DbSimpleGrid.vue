<script setup lang="ts">
import type { ColumnInfo, ColumnMeta } from '@/types/db'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  columns: ColumnInfo[]
  rows: unknown[][]
  pageOffset?: number
  editable?: boolean
  sortColumn?: string | null
  sortDirection?: 'ASC' | 'DESC'
  columnMetadata?: ColumnMeta[]
}>(), {
  pageOffset: 0,
  editable: false,
  sortColumn: null,
  sortDirection: 'ASC',
  columnMetadata: () => [],
})

const emit = defineEmits<{
  'cell-change': [row: number, column: string, value: unknown]
  'sort-change': [column: string]
  'column-selected': [column: string]
  'row-context': [rows: number[], x: number, y: number]
}>()

const ROW_HEIGHT = 28
const OVERSCAN = 8
const MIN_COLUMN_WIDTH = 96
const MAX_COLUMN_WIDTH = 420
const scrollRef = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
const selectedRows = ref(new Set<number>())
const editing = ref<{ row: number; col: number; value: string } | null>(null)
const widths = ref<Record<string, number>>({})
let observer: ResizeObserver | null = null
let resizeState: { column: string; startX: number; startWidth: number } | null = null

const visibleStart = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN))
const visibleEnd = computed(() => Math.min(
  props.rows.length,
  Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN,
))
const visibleRows = computed(() => props.rows.slice(visibleStart.value, visibleEnd.value))
const topSpacer = computed(() => visibleStart.value * ROW_HEIGHT)
const bottomSpacer = computed(() => Math.max(0, props.rows.length - visibleEnd.value) * ROW_HEIGHT)

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function tooltip(column: ColumnInfo): string {
  const meta = props.columnMetadata.find(item => item.name === column.name)
  const details = [
    `${column.name} · ${meta?.type || column.type}`,
    meta?.comment?.trim() || '暂无字段备注',
  ]
  if (meta) {
    details.push(`可空: ${meta.nullable === 'YES' ? '是' : '否'}${meta.key ? ` · 键: ${meta.key}` : ''}${meta.defaultValue !== null ? ` · 默认值: ${String(meta.defaultValue)}` : ''}`)
  }
  return details.join('\n')
}

function columnWidth(column: ColumnInfo, index: number): number {
  const saved = widths.value[column.name]
  if (saved !== undefined) return saved
  const longest = Math.max(column.name.length, ...props.rows.slice(0, 40).map(row => displayValue(row[index]).length))
  return Math.max(MIN_COLUMN_WIDTH, Math.min(240, longest * 8 + 32))
}

function onScroll(event: Event) {
  const target = event.target as HTMLElement
  scrollTop.value = target.scrollTop
}

function selectRow(row: number, event: MouseEvent) {
  const next = new Set(selectedRows.value)
  if (event.ctrlKey || event.metaKey) {
    if (next.has(row)) next.delete(row)
    else next.add(row)
  } else {
    next.clear()
    next.add(row)
  }
  selectedRows.value = next
}

function openEditor(row: number, col: number) {
  if (!props.editable) return
  editing.value = { row, col, value: displayValue(props.rows[row]?.[col]) }
  void nextTick(() => {
    const input = scrollRef.value?.querySelector<HTMLInputElement>('[data-grid-editor]')
    input?.focus()
    input?.select()
  })
}

function coerceValue(value: string, original: unknown, column: ColumnInfo): unknown {
  if (value.trim().toUpperCase() === 'NULL') return null
  if (/int|decimal|numeric|float|double|real/i.test(column.type) && value.trim() !== '') {
    const numberValue = Number(value.trim())
    if (!Number.isNaN(numberValue) && String(numberValue) === value.trim()) return numberValue
  }
  if (/bool|tinyint\(1\)/i.test(column.type)) {
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
  }
  if (typeof original === 'object' && original !== null) {
    try { return JSON.parse(value) as unknown } catch { return value }
  }
  return value
}

function commitEdit() {
  const current = editing.value
  if (!current) return
  const column = props.columns[current.col]
  if (column) emit('cell-change', current.row, column.name, coerceValue(current.value, props.rows[current.row]?.[current.col], column))
  editing.value = null
}

function cancelEdit() {
  editing.value = null
}

function onCellKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    commitEdit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
  }
}

function onRowContext(event: MouseEvent, row: number) {
  event.preventDefault()
  const selected = selectedRows.value.has(row) ? [...selectedRows.value] : [row]
  selectedRows.value = new Set(selected)
  emit('row-context', selected, event.clientX, event.clientY)
}

function startResize(event: PointerEvent, column: ColumnInfo, index: number) {
  event.preventDefault()
  resizeState = { column: column.name, startX: event.clientX, startWidth: columnWidth(column, index) }
  window.addEventListener('pointermove', resizeColumn)
  window.addEventListener('pointerup', endResize, { once: true })
}

function resizeColumn(event: PointerEvent) {
  if (!resizeState) return
  widths.value = {
    ...widths.value,
    [resizeState.column]: Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, resizeState.startWidth + event.clientX - resizeState.startX)),
  }
}

function endResize() {
  resizeState = null
  window.removeEventListener('pointermove', resizeColumn)
}

function updateViewport() {
  viewportHeight.value = scrollRef.value?.clientHeight ?? 0
}

function flushPendingEdit(): Promise<void> {
  commitEdit()
  return Promise.resolve()
}

defineExpose({ flushPendingEdit })

watch(() => props.rows, () => {
  selectedRows.value = new Set()
  editing.value = null
  scrollRef.value?.scrollTo({ top: 0 })
})

onMounted(() => {
  updateViewport()
  if (scrollRef.value) {
    observer = new ResizeObserver(updateViewport)
    observer.observe(scrollRef.value)
  }
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('pointermove', resizeColumn)
})
</script>

<template>
  <div ref="scrollRef" class="db-simple-grid" @scroll="onScroll">
    <table class="db-simple-table">
      <colgroup>
        <col class="row-number-col">
        <col v-for="(column, index) in columns" :key="column.name" :style="{ width: `${columnWidth(column, index)}px` }">
      </colgroup>
      <thead>
        <tr>
          <th class="row-number-header">#</th>
          <th
            v-for="(column, index) in columns" :key="column.name" class="column-header"
            :class="{ sorted: sortColumn === column.name }" :title="tooltip(column)"
            @click="emit('sort-change', column.name); emit('column-selected', column.name)"
          >
            <span class="column-name">{{ column.name }}</span>
            <span v-if="sortColumn === column.name" class="sort-mark">{{ sortDirection === 'DESC' ? '↓' : '↑' }}</span>
            <span class="resize-handle" @pointerdown.stop="startResize($event, column, index)" />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="topSpacer > 0" class="spacer-row"><td :colspan="columns.length + 1" :style="{ height: `${topSpacer}px` }" /></tr>
        <tr
          v-for="(row, offset) in visibleRows" :key="visibleStart + offset" class="data-row"
          :class="{ selected: selectedRows.has(visibleStart + offset) }"
          @click="selectRow(visibleStart + offset, $event)" @contextmenu="onRowContext($event, visibleStart + offset)"
        >
          <td class="row-number">{{ pageOffset + visibleStart + offset + 1 }}</td>
          <td
            v-for="(column, colIndex) in columns" :key="column.name" class="data-cell"
            :class="{ null: row[colIndex] === null || row[colIndex] === undefined, numeric: typeof row[colIndex] === 'number' }"
            @dblclick="openEditor(visibleStart + offset, colIndex)"
          >
            <input
              v-if="editing?.row === visibleStart + offset && editing.col === colIndex" data-grid-editor
              v-model="editing.value" class="cell-editor" @blur="commitEdit" @keydown="onCellKeydown"
            >
            <span v-else>{{ displayValue(row[colIndex]) }}</span>
          </td>
        </tr>
        <tr v-if="bottomSpacer > 0" class="spacer-row"><td :colspan="columns.length + 1" :style="{ height: `${bottomSpacer}px` }" /></tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.db-simple-grid { flex: 1; min-height: 0; overflow: auto; background: var(--panel-solid); }
.db-simple-table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; font: 12px var(--font-mono); }
th, td { height: 28px; box-sizing: border-box; border-right: 1px solid var(--gridline); border-bottom: 1px solid var(--gridline); }
thead { position: sticky; top: 0; z-index: 2; }
.column-header, .row-number-header { position: relative; padding: 0 8px; background: var(--panel-solid-2); color: var(--text-2); text-align: left; cursor: pointer; user-select: none; white-space: nowrap; }
.column-header.sorted { background: var(--active-cyan); color: var(--cyan); }
.row-number-col, .row-number, .row-number-header { width: 52px; }
.row-number { padding: 0 8px; background: var(--panel-solid-2); color: var(--muted); text-align: right; user-select: none; }
.data-row.selected .data-cell, .data-row.selected .row-number { background: var(--active-cyan); }
.data-cell { max-width: 0; padding: 0 8px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.data-cell.null { color: var(--muted); font-style: italic; }
.data-cell.numeric { color: var(--cyan); text-align: right; }
.resize-handle { position: absolute; top: 0; right: -3px; width: 6px; height: 100%; cursor: col-resize; z-index: 3; }
.resize-handle:hover { background: var(--cyan); }
.cell-editor { width: 100%; height: 100%; box-sizing: border-box; border: 1px solid var(--cyan); outline: none; background: var(--panel-solid); color: var(--text); font: inherit; }
.spacer-row td { padding: 0; border: 0; }
</style>
