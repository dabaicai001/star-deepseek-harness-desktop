// @vitest-environment jsdom
/**
 * FileViewerOverlay:壳内文件查看窗——Read 卡看当前文件内容、Edit 卡看
 * 变更前/变更后左右栏;AI 运行中只读并提示;空闲时保存(read 直写,
 * edit 应用 oldText→newText 到最新文件再写回)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { applyDiffs, FileViewerOverlay, type FileViewerOverlayProps } from '../src/client/file-viewer/FileViewerOverlay.tsx'
import type { FileViewerState, FileViewTarget } from '../src/client/file-viewer/state.ts'

/** Tauri IPC stub:local_read_text_file / local_write_text_file。 */
function stubFiles(files: Record<string, string>) {
  const writes: Record<string, string> = {}
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: { path?: string; content?: string }) => {
      const path = args?.path ?? ''
      if (cmd === 'local_read_text_file') {
        if (!(path in files)) return Promise.reject(new Error(`open file failed: ${path}`))
        const content = files[path]!
        return Promise.resolve({ path, content, offset: 0, bytesRead: content.length, totalBytes: content.length, truncated: false })
      }
      if (cmd === 'local_write_text_file') {
        files[path] = args?.content ?? ''
        writes[path] = args?.content ?? ''
        return Promise.resolve((args?.content ?? '').length)
      }
      return Promise.reject(new Error(`unexpected: ${cmd}`))
    },
  }
  return {
    writes,
    restore: () => {
      if (prev === undefined) delete w.__TAURI_INTERNALS__
      else w.__TAURI_INTERNALS__ = prev
    },
  }
}

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
  cleanup()
  vi.restoreAllMocks()
})

/** 组件 props 桩:useFileViewer 返回给定目标;useSessions 读 running。 */
function makeProps(target: FileViewTarget | null, running: boolean): FileViewerOverlayProps {
  const state: FileViewerState = { target }
  return {
    useSessions: ((selector: (s: { byId: Record<string, { running: boolean }> }) => unknown) =>
      selector({ byId: { 'sess-1': { running } } })) as never,
    useFileViewer: ((selector: (s: FileViewerState) => unknown) => selector(state)) as never,
    closeViewer: vi.fn(),
  } as unknown as FileViewerOverlayProps
}

const PATH = 'E:\\ws\\starhub\\README.md'

describe('applyDiffs', () => {
  it('replaces each oldText first occurrence with the edited newText', () => {
    expect(applyDiffs('a=1\nb=2\n', [{ oldText: 'a=1', newText: 'a=10' }])).toBe('a=10\nb=2\n')
  })

  it('rejects pure-insert hunks and stale oldText', () => {
    expect(() => applyDiffs('x', [{ oldText: '', newText: 'y' }])).toThrow('纯新增')
    expect(() => applyDiffs('x', [{ oldText: 'missing', newText: 'y' }])).toThrow('找不到')
  })
})

describe('FileViewerOverlay', () => {
  it('renders nothing without a target', () => {
    const { container } = render(<FileViewerOverlay {...makeProps(null, false)} />)
    expect(container.firstChild).toBeNull()
  })

  it('read kind loads file content and saves edits when idle', async () => {
    const stub = stubFiles({ [PATH]: 'hello' })
    restore = stub.restore
    render(<FileViewerOverlay {...makeProps({ kind: 'read', path: PATH, sessionId: 'sess-1' }, false)} />)
    const editor = await screen.findByDisplayValue('hello')
    fireEvent.change(editor, { target: { value: 'hello world' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => {})
    expect(stub.writes[PATH]).toBe('hello world')
  })

  it('running sessions are view-only with the hint', async () => {
    const stub = stubFiles({ [PATH]: 'hello' })
    restore = stub.restore
    render(<FileViewerOverlay {...makeProps({ kind: 'read', path: PATH, sessionId: 'sess-1' }, true)} />)
    const editor = await screen.findByDisplayValue('hello')
    expect(editor.getAttribute('readonly')).not.toBeNull()
    expect(screen.getAllByText(/AI 运行中只能查看/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true)
  })

  it('edit kind shows before/after columns and applies hunks on save', async () => {
    const stub = stubFiles({ [PATH]: 'a=1\nb=2\n' })
    restore = stub.restore
    render(<FileViewerOverlay {...makeProps({
      kind: 'edit',
      path: PATH,
      sessionId: 'sess-1',
      diffs: [{ oldText: 'a=1', newText: 'a=10' }],
    }, false)} />)
    expect(await screen.findByDisplayValue('a=1')).toBeTruthy()
    expect(screen.getByDisplayValue('a=10')).toBeTruthy()
    expect(screen.getByText('变更前')).toBeTruthy()
    expect(screen.getByText('变更后')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => {})
    expect(stub.writes[PATH]).toBe('a=10\nb=2\n')
  })

  it('surfaces read failures inline', async () => {
    const stub = stubFiles({})
    restore = stub.restore
    render(<FileViewerOverlay {...makeProps({ kind: 'read', path: PATH, sessionId: 'sess-1' }, false)} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})
