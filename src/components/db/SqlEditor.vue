<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { EditorView, basicSetup } from 'codemirror'
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql'
import { Compartment, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { loadHistory, clearHistory, type SqlHistoryEntry } from '@/utils/sqlHistory'

const props = defineProps<{
  modelValue?: string
  dialect?: 'mysql' | 'postgresql' | 'redis'
  readonly?: boolean
  tables?: string[]
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  execute: [sql: string]
  'explain': [sql: string]
}>()

const { t } = useI18n()

const historyOpen = ref(false)
const history = ref<SqlHistoryEntry[]>([])
const historyVersion = ref(0)

function toggleHistory() {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) {
    history.value = loadHistory()
  }
}

function refreshHistory() {
  history.value = loadHistory()
}

function useHistory(entry: SqlHistoryEntry) {
  emit('update:modelValue', entry.sql)
}

function onClearHistory() {
  clearHistory()
  history.value = []
}

const editorRef = ref<HTMLElement>()
let editorView: EditorView | null = null
const langCompartment = new Compartment()

const cyberTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent !important',
    fontSize: '14px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    height: '100%'
  },
  '.cm-editor': {
    backgroundColor: 'transparent !important'
  },
  '.cm-scroller': {
    backgroundColor: 'transparent !important',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    lineHeight: '1.7'
  },
  '.cm-content': {
    caretColor: 'var(--cyan)',
    color: 'var(--text)',
    padding: '14px 12px',
    minHeight: '80px'
  },
  '.cm-line': {
    padding: '0 4px'
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--cyan)',
    borderLeftWidth: '2px'
  },
  '.cm-keyword': {
    color: 'var(--cyan)',
    fontWeight: '600'
  },
  '.cm-string': {
    color: 'var(--green)'
  },
  '.cm-number': {
    color: 'var(--yellow)'
  },
  '.cm-atom, .cm-bool': {
    color: 'var(--pink)'
  },
  '.cm-comment': {
    color: 'var(--muted)',
    fontStyle: 'italic'
  },
  '.cm-operator': {
    color: 'var(--cyan)'
  },
  '.cm-typeName': {
    color: 'var(--purple)'
  },
  '.cm-variableName': {
    color: 'var(--text-2)'
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--active-cyan) !important'
  },
  '&:not(.cm-focused) .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--hover-cyan) !important'
  },
  '& .cm-content ::selection': {
    backgroundColor: 'var(--focus-cyan)'
  },
  '& .cm-editor': {
    outline: 'none !important'
  },
  '& .cm-editor.cm-focused': {
    outline: 'none !important'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '1px solid var(--line)',
    color: 'var(--muted)'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--hover-cyan-soft)',
    color: 'var(--cyan)'
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--hover-cyan-faint)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--icon-bg-purple)',
    border: '1px solid var(--line-2)',
    color: 'var(--purple)'
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--panel-solid-2)',
    border: '1px solid var(--line-2)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow)'
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '4px 8px'
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'var(--focus-cyan)',
      color: 'var(--cyan)'
    }
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-2)',
    borderColor: 'var(--line-2)'
  },
  '.cm-panel.cm-search': {
    '& input, & button, & label': {
      color: 'var(--text)'
    },
    '& input': {
      backgroundColor: 'var(--panel-solid-2)',
      border: '1px solid var(--line-2)',
      borderRadius: '4px'
    }
  }
})

function buildLangExtension() {
  if (props.dialect === 'redis') return []
  const dialect = props.dialect === 'postgresql' ? PostgreSQL : MySQL
  return sql({
    dialect,
    schema: {},
    tables: props.tables?.map(t => ({ label: t })) || []
  })
}

function createEditor() {
  if (!editorRef.value) return

  const extensions = [
    basicSetup,
    cyberTheme,
    langCompartment.of(buildLangExtension()),
    keymap.of([
      ...defaultKeymap,
      indentWithTab,
      {
        key: 'Mod-Enter',
        run: () => {
          const val = editorView?.state.doc.toString() || ''
          if (val.trim()) emit('execute', val)
          return true
        }
      },
      {
        key: 'Shift-Mod-e',
        run: () => {
          const val = editorView?.state.doc.toString() || ''
          if (val.trim()) emit('explain', val)
          return true
        }
      }
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        emit('update:modelValue', update.state.doc.toString())
      }
    })
  ]

  if (props.readonly) {
    extensions.push(EditorState.readOnly.of(true))
  }

  const state = EditorState.create({
    doc: props.modelValue || '',
    extensions
  })

  editorView = new EditorView({
    state,
    parent: editorRef.value
  })
}

watch(() => props.tables, () => {
  if (editorView) {
    editorView.dispatch({
      effects: langCompartment.reconfigure(buildLangExtension())
    })
  }
})

watch(() => props.modelValue, (val) => {
  if (editorView && val !== editorView.state.doc.toString()) {
    editorView.dispatch({
      changes: {
        from: 0,
        to: editorView.state.doc.length,
        insert: val || ''
      }
    })
  }
})

onMounted(() => {
  createEditor()
})

onBeforeUnmount(() => {
  editorView?.destroy()
  editorView = null
})

function focus() {
  editorView?.focus()
}

defineExpose({ focus, refreshHistory, historyVersion })
</script>

<template>
  <div class="sql-editor-wrap">
    <button class="history-toggle" @click="toggleHistory" :title="t('db.sqlHistory')">
      <v-icon size="14">mdi-history</v-icon>
    </button>
    <div class="sql-editor" ref="editorRef"></div>
    <div v-if="historyOpen" class="history-panel">
      <div class="history-header">
        <span>{{ t('db.sqlHistory') }}</span>
        <button class="action-btn-sm" @click="onClearHistory" :title="t('ssh.clear')">
          <v-icon size="12">mdi-delete-outline</v-icon>
        </button>
      </div>
      <div class="history-list">
        <div v-if="history.length === 0" class="history-empty">{{ t('common.noData') }}</div>
        <div
          v-for="(entry, idx) in history"
          :key="idx"
          class="history-item"
          @click="useHistory(entry)"
        >
          <span v-if="entry.db" class="history-db">{{ entry.db }}</span>
          <code class="history-sql">{{ entry.sql.length > 60 ? entry.sql.slice(0, 60) + '...' : entry.sql }}</code>
          <span class="history-time">{{ new Date(entry.time).toLocaleTimeString() }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sql-editor {
  width: 100%;
  min-height: 100px;
  max-height: 400px;
  overflow: auto;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background: var(--panel-solid-2);
  /* 左侧 2px accent 条 + 顶部 1px 高光,跟下面的"数据结果"区分开 */
  box-shadow:
    inset 2px 0 0 var(--cyan),
    0 1px 0 rgba(0, 240, 255, 0.08);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.sql-editor:focus-within {
  border-color: rgba(0, 240, 255, 0.35);
  box-shadow:
    inset 2px 0 0 var(--cyan),
    0 0 0 1px rgba(0, 240, 255, 0.18),
    0 0 16px -4px rgba(0, 240, 255, 0.25);
}

.sql-editor :deep(.cm-editor) {
  height: 100%;
  background: transparent !important;
}

.sql-editor :deep(.cm-editor.cm-focused) {
  outline: none !important;
}

.sql-editor :deep(.cm-scroller) {
  overflow: auto;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}

/* placeholder 提示(空编辑器时显示一句灰色提示) */
.sql-editor :deep(.cm-placeholder) {
  color: var(--text-2);
  font-style: italic;
}

.sql-editor-wrap {
  display: flex;
  flex-direction: row;
  height: 100%;
  position: relative;
}
.sql-editor-wrap .sql-editor {
  flex: 1;
  min-width: 0;
}
.history-toggle {
  position: absolute;
  top: 4px; right: 8px;
  z-index: 5;
  width: 24px; height: 24px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  background: var(--panel-solid);
  color: var(--text-2);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.history-toggle:hover { border-color: var(--cyan); color: var(--cyan); }
.history-panel {
  width: 240px;
  flex-shrink: 0;
  border-left: 1px solid var(--line);
  background: var(--panel-solid);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.history-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  font-size: 11px; font-weight: 600; color: var(--text-2);
}
.history-list {
  flex: 1; overflow: auto; padding: 4px;
}
.history-empty {
  padding: 12px; text-align: center;
  font-size: 11px; color: var(--muted);
}
.history-item {
  padding: 6px 8px; border-radius: 4px; cursor: pointer;
  display: flex; flex-direction: column; gap: 2px;
}
.history-item:hover { background: rgba(0,240,255,.06); }
.history-db {
  font-size: 9px; color: var(--cyan);
  font-family: 'JetBrains Mono', monospace;
}
.history-sql {
  font-size: 11px; color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.history-time {
  font-size: 9px; color: var(--muted);
  font-family: 'JetBrains Mono', monospace;
}
.action-btn-sm {
  width: 22px; height: 22px; border-radius: 4px;
  border: 1px solid var(--line-2); background: transparent;
  color: var(--text-2); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.action-btn-sm:hover { border-color: var(--cyan); color: var(--cyan); }
</style>
