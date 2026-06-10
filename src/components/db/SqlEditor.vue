<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { EditorView, basicSetup } from 'codemirror'
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql'
import { Compartment, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'

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

defineExpose({ focus })
</script>

<template>
  <div class="sql-editor" ref="editorRef"></div>
</template>

<style scoped>
.sql-editor {
  width: 100%;
  min-height: 140px;
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
</style>
