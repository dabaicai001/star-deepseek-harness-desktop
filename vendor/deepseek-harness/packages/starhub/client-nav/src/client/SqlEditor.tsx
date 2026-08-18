/**
 * StarHub 原生 SQL 编辑器(需求 5 React 化,批次 2),基于 CodeMirror 6。
 *
 * 对齐 Vue SqlEditor 的能力集:
 * - 语法高亮:@codemirror/lang-sql(MySQL / PostgreSQL 方言,Redis 无方言)。
 * - 补全:列名补全(WHERE/AND/OR/ON/SET/BY/,/( 后),表. 前缀交给 lang-sql 的
 *   schema 补全;schema 由父组件传入 `columnsByTable`(与 Vue 的 sqlCompletionSchema
 *   同构,DbWorkbench 负责从 SQL 提取表名→listColumns 惰性缓存)。
 * - 快捷键:Mod-Enter 执行、Shift-Mod-e EXPLAIN、indentWithTab。
 * - 只读/可写、内容受控(受控 value + onChange)。
 *
 * CM6 依赖与 Vue 同款(@codemirror/state/view/lang-sql/autocomplete/commands),
 * shell bundle 已含 xterm 先例,第三方编辑器库可正常打包。
 *
 * @module StarHub SQL editor (client)
 */

import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql'
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import css from './SqlEditor.module.css'

/** 表 → 列名映射(补全 schema;与 Vue 端 sqlCompletionSchema 同构)。 */
export interface SqlCompletionSchema {
  [table: string]: string[]
}

/** 编辑器方言。 */
export type SqlDialect = 'mysql' | 'postgresql' | 'sqlite' | 'mssql'

/** SQL 编辑器 props。 */
export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  /** 补全 schema(表→列);缺省禁用表/列补全。 */
  schema?: SqlCompletionSchema
  dialect?: SqlDialect
  /** 执行回调(Mod-Enter);返回 Promise 以便编辑器知道执行中。 */
  onExecute?: (sql: string, explain: boolean) => void
  placeholder?: string
}

/** 列补全 source:在列名语境(非「表.」前缀)回填 schema 全表列名;`表.` 前缀交给
 * lang-sql 的 schema 补全——与 Vue 端 columnCompletionSource(Vue SqlEditor.vue:195)
 * 同语义。schema 缺失时不补全。 */
function columnCompletion(schema: SqlCompletionSchema | undefined): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    if (schema === undefined) return null
    const before = context.matchBefore(/[\w$.-]*/)
    if (before === null) return null
    // 「表.」前缀交给 lang-sql,不在这里重复补全。
    if (/\.\s*$/.test(before.text)) return null
    const word = before.text.toLowerCase()
    const allColumns = new Set<string>()
    for (const cols of Object.values(schema)) for (const c of cols) allColumns.add(c)
    const options = [...allColumns]
      .filter((c) => c.toLowerCase().includes(word))
      .map((c) => ({ label: c, type: 'property' }))
    if (options.length === 0) return null
    return { from: before.from, options, validFor: /^[\w$.-]*$/ }
  }
}

/** 构造 CM6 extensions(在组件外缓存纯函数,避免每次渲染重建)。 */
function buildExtensions(opts: {
  value: string
  onChange: (v: string) => void
  schema?: SqlCompletionSchema
  dialect?: SqlDialect
  onExecute?: (sql: string, explain: boolean) => void
  placeholder?: string
  viewRef: { current: EditorView | null }
}): Extension[] {
  const language = opts.dialect === 'postgresql' ? PostgreSQL : opts.dialect === 'mysql' ? MySQL : sql()
  const executeKeymap = opts.onExecute === undefined ? [] : [
    { key: 'Mod-Enter', run: () => { opts.onExecute!(viewValue(opts.viewRef), false); return true } },
    { key: 'Shift-Mod-e', run: () => { opts.onExecute!(viewValue(opts.viewRef), true); return true } },
  ]
  return [
    language,
    history(),
    autocompletion({ override: [columnCompletion(opts.schema)] }),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, ...executeKeymap]),
    EditorView.lineWrapping,
    cmPlaceholder(opts.placeholder ?? '输入 SQL,Mod-Enter 执行'),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString())
    }),
  ]
}

/** 从当前 EditorView 取全文(M-fold:用于快捷键回调拿最新值)。 */
function viewValue(ref: { current: EditorView | null }): string {
  return ref.current?.state.doc.toString() ?? ''
}

/**
 * Render a CodeMirror 6 SQL editor with schema-aware completion and the
 * StarHub execute keybinds (Mod-Enter / Shift-Mod-e).
 * @param props - controlled value, schema, dialect, execute callback.
 * @returns the editor mounting div.
 */
export function SqlEditor({ value, onChange, schema, dialect = 'mysql', onExecute, placeholder }: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  // 建一次 view(严格模式双跑由 dispose 抵消)。
  useEffect(() => {
    if (hostRef.current === null) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: buildExtensions({
          value, onChange, dialect, viewRef,
          ...(schema !== undefined ? { schema } : {}),
          ...(onExecute !== undefined ? { onExecute } : {}),
          ...(placeholder !== undefined ? { placeholder } : {}),
        }),
      }),
    })
    viewRef.current = view
    const host = hostRef.current
    if (typeof ResizeObserver !== 'undefined' && host !== null) {
      const ro = new ResizeObserver(() => view.requestMeasure())
      ro.observe(host)
      return () => {
        ro.disconnect()
        view.destroy()
        viewRef.current = null
      }
    }
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // 只建一次;外部 value 同步走下方 effect。buildExtensions 依赖变化由
    // 下方 dispatch 覆盖(受控文本)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 受控 value 同步:外部变化时更新编辑器(避免光标重置:仅当 doc 不同才 replace)。
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className={css.editor} />
}

export default SqlEditor
