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
    backgroundColor: 'transparent',
    fontSize: '13px',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace"
  },
  '.cm-content': {
    caretColor: '#00f0ff',
    color: '#e8efff',
    padding: '8px 0'
  },
  '.cm-cursor': {
    borderLeftColor: '#00f0ff',
    borderLeftWidth: '2px'
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(0, 240, 255, 0.12) !important'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: '1px solid rgba(120, 160, 255, 0.08)',
    color: '#5a6a96'
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(0, 240, 255, 0.06)',
    color: '#00f0ff'
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(0, 240, 255, 0.04)'
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'rgba(181, 107, 255, 0.1)',
    border: '1px solid rgba(181, 107, 255, 0.2)',
    color: '#b56bff'
  },
  '.cm-tooltip': {
    backgroundColor: '#141928',
    border: '1px solid rgba(120, 160, 255, 0.15)',
    borderRadius: '8px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)'
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li': {
      padding: '4px 8px'
    },
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(0, 240, 255, 0.1)',
      color: '#00f0ff'
    }
  },
  '.cm-panels': {
    backgroundColor: '#0a0e1a',
    borderColor: 'rgba(120, 160, 255, 0.15)'
  },
  '.cm-panel.cm-search': {
    '& input, & button, & label': {
      color: '#e8efff'
    },
    '& input': {
      backgroundColor: '#141928',
      border: '1px solid rgba(120, 160, 255, 0.15)',
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
  min-height: 120px;
  max-height: 400px;
  overflow: auto;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: var(--panel-solid-2);
}

.sql-editor:focus-within {
  border-color: rgba(0, 240, 255, 0.3);
  box-shadow: 0 0 0 1px rgba(0, 240, 255, 0.1);
}

.sql-editor :deep(.cm-editor) {
  height: 100%;
}

.sql-editor :deep(.cm-scroller) {
  overflow: auto;
}
</style>
