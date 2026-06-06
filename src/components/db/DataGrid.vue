<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { QueryResult, ColumnInfo } from '@/types/db'

const { t } = useI18n()

const props = defineProps<{
  result: QueryResult | null
  loading?: boolean
}>()

const emit = defineEmits<{
  cellEdit: [row: number, col: string, value: unknown]
  rowDelete: [row: number]
  export: [format: string]
}>()

const sortColumn = ref<string | null>(null)
const sortDir = ref<'ASC' | 'DESC'>('ASC')
const filterText = ref('')
const currentPage = ref(0)
const pageSize = ref(100)

const columns = computed(() => props.result?.columns || [])
const allRows = computed(() => props.result?.rows || [])

const sortedRows = computed(() => {
  let rows = [...allRows.value]
  if (sortColumn.value && columns.value.length > 0) {
    const colIdx = columns.value.findIndex(c => c.name === sortColumn.value)
    if (colIdx >= 0) {
      rows.sort((a, b) => {
        const va = a[colIdx]
        const vb = b[colIdx]
        if (va == null && vb == null) return 0
        if (va == null) return 1
        if (vb == null) return -1
        const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true })
        return sortDir.value === 'ASC' ? cmp : -cmp
      })
    }
  }
  return rows
})

const filteredRows = computed(() => {
  if (!filterText.value) return sortedRows.value
  const q = filterText.value.toLowerCase()
  return sortedRows.value.filter(row =>
    row.some(cell => cell != null && String(cell).toLowerCase().includes(q))
  )
})

const totalPages = computed(() => Math.ceil(filteredRows.value.length / pageSize.value))

const pagedRows = computed(() => {
  const start = currentPage.value * pageSize.value
  return filteredRows.value.slice(start, start + pageSize.value)
})

const visibleRange = computed(() => {
  const start = currentPage.value * pageSize.value + 1
  const end = Math.min(start + pageSize.value - 1, filteredRows.value.length)
  return { start, end, total: filteredRows.value.length }
})

watch(() => props.result, () => {
  currentPage.value = 0
  sortColumn.value = null
  filterText.value = ''
})

function toggleSort(col: string) {
  if (sortColumn.value === col) {
    sortDir.value = sortDir.value === 'ASC' ? 'DESC' : 'ASC'
  } else {
    sortColumn.value = col
    sortDir.value = 'ASC'
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function getCellClass(value: unknown): string {
  if (value === null || value === undefined) return 'cell-null'
  if (typeof value === 'number') return 'cell-number'
  if (typeof value === 'boolean') return 'cell-boolean'
  return 'cell-text'
}

function prevPage() {
  if (currentPage.value > 0) currentPage.value--
}

function nextPage() {
  if (currentPage.value < totalPages.value - 1) currentPage.value++
}
</script>

<template>
  <div class="data-grid">
    <!-- Toolbar -->
    <div class="grid-toolbar">
      <div class="toolbar-left">
        <v-icon size="14" color="purple">mdi-table</v-icon>
        <span v-if="result" class="row-count">
          {{ result.rows.length }} {{ t('db.rows') }}
          <span v-if="result.durationMs != null" class="duration">· {{ result.durationMs }}ms</span>
        </span>
        <span v-if="result?.error" class="error-badge">
          <v-icon size="12">mdi-alert-circle</v-icon>
          {{ result.error }}
        </span>
      </div>
      <div class="toolbar-right">
        <input
          v-model="filterText"
          type="text"
          class="cyber-input filter-input"
          :placeholder="t('common.search') + '...'"
        />
        <button class="action-btn" @click="emit('export', 'csv')" :title="t('db.export')">
          <v-icon size="14">mdi-download</v-icon>
        </button>
      </div>
    </div>

    <!-- Table -->
    <div v-if="loading" class="grid-loading">
      <v-icon size="24" class="spin">mdi-loading</v-icon>
      <span>{{ t('common.loading') }}</span>
    </div>

    <div v-else-if="!result || columns.length === 0" class="grid-empty">
      <v-icon size="32" color="muted">mdi-table-off</v-icon>
      <span>{{ t('common.noData') }}</span>
    </div>

    <template v-else>
      <div class="grid-scroll">
        <table class="grid-table">
          <thead>
            <tr>
              <th class="col-index">#</th>
              <th
                v-for="col in columns"
                :key="col.name"
                class="col-header"
                :class="{ sorted: sortColumn === col.name, desc: sortDir === 'DESC' }"
                @click="toggleSort(col.name)"
              >
                <span class="col-name">{{ col.name }}</span>
                <span class="col-type">{{ col.type }}</span>
                <v-icon v-if="sortColumn === col.name" size="10" class="sort-icon">
                  {{ sortDir === 'ASC' ? 'mdi-arrow-up' : 'mdi-arrow-down' }}
                </v-icon>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIdx) in pagedRows" :key="rowIdx">
              <td class="col-index">{{ currentPage * pageSize + rowIdx + 1 }}</td>
              <td
                v-for="(cell, colIdx) in row"
                :key="colIdx"
                :class="getCellClass(cell)"
                class="cell"
              >
                <span class="cell-value" :title="formatCell(cell)">{{ formatCell(cell) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div class="grid-pagination" v-if="totalPages > 1">
        <span class="page-info">{{ visibleRange.start }}-{{ visibleRange.end }} / {{ visibleRange.total }}</span>
        <button class="page-btn" :disabled="currentPage === 0" @click="prevPage">
          <v-icon size="14">mdi-chevron-left</v-icon>
        </button>
        <span class="page-num">{{ currentPage + 1 }} / {{ totalPages }}</span>
        <button class="page-btn" :disabled="currentPage >= totalPages - 1" @click="nextPage">
          <v-icon size="14">mdi-chevron-right</v-icon>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.data-grid {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.grid-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-input {
  width: 180px;
  padding: 4px 8px;
  font-size: 11px;
}

.row-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.duration {
  color: var(--muted);
}

.error-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--red);
  font-size: 11px;
  background: rgba(255, 77, 109, 0.08);
  padding: 2px 8px;
  border-radius: 4px;
}

.grid-loading, .grid-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: var(--muted);
  font-size: 13px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.grid-scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.grid-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-family: 'JetBrains Mono', monospace;
}

.grid-table thead {
  position: sticky;
  top: 0;
  z-index: 1;
}

.col-header {
  background: var(--panel-solid-2);
  border-bottom: 1px solid var(--line-2);
  padding: 6px 10px;
  text-align: left;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.15s;
  position: relative;
}

.col-header:hover {
  background: rgba(0, 240, 255, 0.06);
}

.col-header.sorted {
  background: rgba(181, 107, 255, 0.06);
}

.col-name {
  font-weight: 600;
  color: var(--text);
  margin-right: 6px;
}

.col-type {
  font-size: 10px;
  color: var(--muted);
  font-weight: 400;
}

.sort-icon {
  margin-left: 4px;
  color: var(--purple);
}

.col-index {
  width: 40px;
  text-align: right;
  padding: 4px 8px;
  color: var(--muted);
  font-size: 10px;
  background: var(--panel-solid-2);
  border-bottom: 1px solid var(--line);
  position: sticky;
  left: 0;
  z-index: 1;
}

.cell {
  padding: 4px 10px;
  border-bottom: 1px solid var(--line);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell:hover {
  background: rgba(0, 240, 255, 0.04);
}

.cell-null {
  color: var(--muted);
  font-style: italic;
  font-size: 10px;
}

.cell-number {
  color: var(--cyan);
}

.cell-boolean {
  color: var(--purple);
}

.cell-text {
  color: var(--text);
}

.cell-value {
  display: inline-block;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grid-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--text-2);
  flex-shrink: 0;
}

.page-info {
  font-family: 'JetBrains Mono', monospace;
  color: var(--muted);
}

.page-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.page-btn:hover:not(:disabled) {
  border-color: var(--cyan);
  color: var(--cyan);
}

.page-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.page-num {
  font-family: 'JetBrains Mono', monospace;
  min-width: 60px;
  text-align: center;
}

.action-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.action-btn:hover {
  border-color: var(--cyan);
  color: var(--cyan);
}
</style>
