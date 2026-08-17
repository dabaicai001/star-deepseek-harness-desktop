import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import type { RustAsset } from '../store.ts'
import css from './SshTerminalOverlay.module.css'

/** Props for one native SSH terminal overlay. */
export interface SshTerminalOverlayProps {
  asset: RustAsset
  onClose: () => void
}

/**
 * Render one xterm instance backed by a StarHub interactive SSH session.
 * The component owns the Tauri event subscriptions, resize observer, and
 * session cleanup for the selected asset.
 * @param props - selected SSH asset and overlay close callback.
 * @returns the native SSH terminal overlay.
 */
export function SshTerminalOverlay({ asset, onClose }: SshTerminalOverlayProps) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#101822' },
    })
    const addon = new FitAddon()
    term.loadAddon(addon)
    if (host.current !== null) {
      term.open(host.current)
      addon.fit()
    }

    const sessionId = asset.id
    let disposed = false
    let connected = false
    let resizeObserver: ResizeObserver | undefined
    let unlistenData: TauriUnlisten | undefined
    let unlistenClose: TauriUnlisten | undefined
    const input = term.onData((data) => {
      if (connected) void tauriInvoke('ssh_write', { id: sessionId, data }).catch(() => {})
    })

    const resize = () => {
      addon.fit()
      if (connected) void tauriInvoke('ssh_resize', { id: sessionId, cols: term.cols, rows: term.rows }).catch(() => {})
    }

    const connect = async () => {
      try {
        [unlistenData, unlistenClose] = await Promise.all([
          tauriListen<number[]>(`ssh:data:${sessionId}`, (bytes) => {
            if (!disposed) term.write(new Uint8Array(bytes))
          }),
          tauriListen<string>(`ssh:close:${sessionId}`, (reason) => {
            connected = false
            if (!disposed) term.writeln(`\r\n[连接已关闭: ${reason}]`)
          }),
        ])
        if (disposed) {
          void unlistenData?.()
          void unlistenClose?.()
          return
        }
        await tauriInvoke('ssh_connect', {
          id: sessionId,
          config: { ...asset.config, pty_cols: term.cols, pty_rows: term.rows },
        })
        if (disposed) {
          void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
          return
        }
        connected = true
        resizeObserver = new ResizeObserver(resize)
        if (host.current !== null) resizeObserver.observe(host.current)
        resize()
        term.focus()
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught))
      }
    }

    void connect()
    return () => {
      disposed = true
      connected = false
      input.dispose()
      resizeObserver?.disconnect()
      void unlistenData?.()
      void unlistenClose?.()
      void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
      term.dispose()
    }
  }, [asset])

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`SSH 终端 ${asset.name}`}>
        <header><strong>{asset.name}</strong><button type="button" onClick={onClose}>关闭</button></header>
        {error !== null && <div className={css.error}>{error}</div>}
        <div ref={host} className={css.terminal} />
      </section>
    </div>
  )
}
