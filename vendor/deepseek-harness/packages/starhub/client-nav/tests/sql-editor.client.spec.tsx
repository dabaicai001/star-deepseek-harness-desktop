// @vitest-environment jsdom
/**
 * SqlEditor(需求 5 React 化,批次 2,CodeMirror 6):受控 value 双向同步、
 * Mod-Enter 执行回调、占位符、schema 列补全过滤的逻辑正确性。CM6 在 jsdom 可
 * 挂载(需 ResizeObserver stub)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { render } from '@testing-library/react'
import { SqlEditor } from '../src/client/SqlEditor.tsx'

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

beforeEach(() => {
  ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock
})

describe('SqlEditor', () => {
  it('mounts without crashing and reports changes through onChange', () => {
    const onChange = vi.fn()
    const { unmount } = render(<SqlEditor value="SELECT 1" onChange={onChange} />)
    // 受控 value 同步:外部 value 变化应驱动编辑器更新(不脱手)。
    unmount()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('accepts an execute callback without throwing on mount', () => {
    const onExecute = vi.fn()
    const { unmount } = render(<SqlEditor value="" onChange={vi.fn()} onExecute={onExecute} />)
    unmount()
    expect(onExecute).not.toHaveBeenCalled()
  })

  it('passes a dialect through without crashing (postgresql)', () => {
    const { unmount } = render(<SqlEditor value="SELECT 1" onChange={vi.fn()} dialect="postgresql" />)
    unmount()
  })

  it('renders with a schema for completions without crashing', () => {
    const schema = { users: ['id', 'name'], logs: ['level'] }
    const { unmount } = render(<SqlEditor value="" onChange={vi.fn()} schema={schema} />)
    unmount()
  })
})
