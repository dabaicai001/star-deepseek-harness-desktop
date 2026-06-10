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
  // 关键:CodeMirror basicSetup 默认会注入白底主题,
  // 必须把 .cm-editor / .cm-scroller 显式拉成透明,才看得到外层的深色面板
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
    caretColor: '#00f0ff',
    color: '#f0f4ff',
    padding: '14px 12px',
    minHeight: '80px'
  },
  '.cm-line': {
    padding: '0 4px'
  },
  '.cm-cursor': {
    borderLeftColor: '#00f0ff',
    borderLeftWidth: '2px'
  },
  '.cm-keyword': {
    color: '#00f0ff',
    fontWeight: '600'
  },
  '.cm-string': {
    color: '#64ffa0'
  },
  '.cm-number': {
    color: '#ffb864'
  },
  '.cm-atom, .cm-bool': {
    color: '#ff6eb4'
  },
  '.cm-comment': {
    color: '#4a5a80',
    fontStyle: 'italic'
  },
  '.cm-operator': {
    color: '#00f0ff'
  },
  '.cm-typeName': {
    color: '#b56bff'
  },
  '.cm-variableName': {
    color: '#d0d8f0'
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(0, 240, 255, 0.12) !important'
  },
  // 覆盖 CodeMirror 默认的未聚焦 selection 虚线 outline —
  // 未聚焦时也保持主色高亮,避免视觉上的"虚线/残影"
  '&:not(.cm-focused) .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(0, 240, 255, 0.08) !important'
  },
  // ::selection 是浏览器原生的虚线框,默认会在编辑器未聚焦时出现
  '& .cm-content ::selection': {
    backgroundColor: 'rgba(0, 240, 255, 0.18)'
  },
  // 关掉 focus ring(我们已经在外层 .sql-editor:focus-within 加了 box-shadow)
  '& .cm-editor': {
    outline: 'none !important'
  },
  '& .cm-editor.cm-focused': {
    outline: 'none !important'
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
