// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

const xterm = vi.hoisted(() => ({
  dispose: vi.fn(),
  input: undefined as ((data: string) => void) | undefined,
  write: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    focus() {}
    dispose = xterm.dispose
    write = xterm.write
    onData(handler: (data: string) => void) {
      xterm.input = handler
      return { dispose: vi.fn() }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

import { SshTerminalOverlay } from '../src/client/terminal/SshTerminalOverlay.tsx'

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const asset = {
  id: 'ssh-1', type: 'ssh', name: 'server', group_id: null,
  config: { host: '10.0.0.5', port: 22, username: 'deploy', password: 'secret' },
  key_id: null, tags: [], favorite: false, last_used_at: null, created_at: 0, updated_at: 0,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  xterm.dispose.mockReset()
  xterm.input = undefined
  xterm.write.mockReset()
})

describe('SshTerminalOverlay', () => {
  it('subscribes before connecting, streams terminal bytes, and releases resources', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      return Promise.resolve(null)
    })
    ;(window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: typeof invoke
        transformCallback: (callback: (event: unknown) => void) => number
      }
    }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
    }
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock

    const { unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ssh_connect', {
      id: 'ssh-1',
      config: expect.objectContaining({ pty_cols: 80, pty_rows: 24 }),
    }))
    expect(invoke.mock.calls.findIndex(([command]) => command === 'plugin:event|listen'))
      .toBeLessThan(invoke.mock.calls.findIndex(([command]) => command === 'ssh_connect'))

    callbacks[0]?.({ event: 'ssh:data:ssh-1', id: 1, payload: [104, 105] })
    expect(xterm.write).toHaveBeenCalledWith(new Uint8Array([104, 105]))
    xterm.input?.('ls\r')
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ssh_write', { id: 'ssh-1', data: 'ls\r' }))

    unmount()
    expect(xterm.dispose).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('ssh_disconnect', { id: 'ssh-1' })
    expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', { event: 'ssh:data:ssh-1', eventId: 1 })
    expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', { event: 'ssh:close:ssh-1', eventId: 2 })
  })
})
