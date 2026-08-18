// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

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
      config: expect.objectContaining({
        pty_cols: 80,
        pty_rows: 24,
        auth: { Password: 'secret' },
      }),
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

  it('switches to the SFTP tab which reuses the live terminal session', async () => {
    const callbacks: Array<(event: unknown) => void> = []
    const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
      if (command === 'plugin:event|listen') return Promise.resolve(callbacks.length)
      if (command === 'sftp_ensure_session') return Promise.resolve({ mode: 'subsystem' })
      if (command === 'sftp_home_dir') return Promise.resolve('/home/deploy')
      if (command === 'sftp_list') {
        const path = (args?.path as string) ?? ''
        return Promise.resolve(path === '/home/deploy'
          ? [{ name: 'docs', path: '/home/deploy/docs', isDir: true, size: 0, permissions: 0o755, modified: 0 }]
          : [])
      }
      if (command === 'sftp_list_transfers') return Promise.resolve([])
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
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }

    const { getByText, getByRole, unmount } = render(<SshTerminalOverlay asset={asset} onClose={vi.fn()} />)
    // two tabs offered: 终端 + 文件 (SFTP)
    expect(getByText('终端')).toBeTruthy()
    // wait for the terminal to connect (so the SFTP tab reuses a live session)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ssh_connect', expect.any(Object)))
    // click the SFTP tab
    fireEvent.click(getByRole('button', { name: /文件/ }))
    // SFTP panel connects on the same session id (never a separate session)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('sftp_ensure_session', { id: 'ssh-1' }))
    expect(invoke).toHaveBeenCalledWith('sftp_list', { id: 'ssh-1', path: '/home/deploy' })
    await waitFor(() => expect(getByText('docs')).toBeTruthy())
    unmount()
  })
})
