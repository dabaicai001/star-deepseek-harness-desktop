/**
 * Shell-native SSH/SFTP terminal overlay.
 *
 * Opened in-page (no new window) when an SSH asset is clicked. Owns one xterm
 * instance connected via the StarHub interactive SSH session, and exposes a
 * second tab with the native SFTP file-transfer panel that reuses the same live
 * session (`sftp_ensure_session` opens the channel on it). SSH terminal and
 * SFTP inherently share one connection, so they ride the same overlay.
 *
 * @module StarHub SSH/SFTP overlay (client)
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { tauriInvoke, tauriListen, type TauriUnlisten } from '../tauri.ts'
import type { RustAsset } from '../store.ts'
import { SftpPanel } from './SftpPanel.tsx'
import css from './SshTerminalOverlay.module.css'

/** Props for one native SSH/SFTP terminal overlay. */
export interface SshTerminalOverlayProps {
  asset: RustAsset
  onClose: () => void
}

type OverlayTab = 'terminal' | 'sftp'

/**
 * Build the Rust `SshAuth` variant from an asset config, mirroring the Vue
 * `buildAuth` (src/services/ssh.ts): password / private key / both, with the
 * usePasswordAuth / useKeyAuth flags; falls back to an empty password so the
 * connect still reaches the Rust auth negotiation.
 * @param config - the hydrated asset config (get_assets merges keyring secrets).
 * @returns the serde `SshAuth` tagged object.
 */
function buildSshAuth(config: Record<string, unknown>): Record<string, unknown> {
  const usePassword = config.usePasswordAuth !== false
  const useKey = config.useKeyAuth === true
  const password = typeof config.password === 'string' ? config.password : ''
  const privateKey = typeof config.privateKey === 'string' ? config.privateKey : ''
  const passphrase = typeof config.passphrase === 'string' ? config.passphrase : null
  if (usePassword && useKey && password !== '' && privateKey !== '') {
    return { PasswordAndKey: { password, key: privateKey, passphrase } }
  }
  if (password !== '' && usePassword) return { Password: password }
  if (privateKey !== '' && useKey) return { PrivateKey: { key: privateKey, passphrase } }
  return { Password: '' }
}

/**
 * Render one xterm instance backed by a StarHub interactive SSH session.
 * The component owns the Tauri event subscriptions, resize observer, and
 * session cleanup for the selected asset.
 * @param props - selected SSH asset and overlay close callback.
 * @returns the native SSH/SFTP terminal overlay.
 */
export function SshTerminalOverlay({ asset, onClose }: SshTerminalOverlayProps) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [tab, setTab] = useState<OverlayTab>('terminal')

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
    let isConnected = false
    let resizeObserver: ResizeObserver | undefined
    let unlistenData: TauriUnlisten | undefined
    let unlistenClose: TauriUnlisten | undefined
    const input = term.onData((data) => {
      if (isConnected) void tauriInvoke('ssh_write', { id: sessionId, data }).catch(() => {})
    })

    const resize = () => {
      addon.fit()
      if (isConnected) void tauriInvoke('ssh_resize', { id: sessionId, cols: term.cols, rows: term.rows }).catch(() => {})
    }

    const connect = async () => {
      try {
        [unlistenData, unlistenClose] = await Promise.all([
          tauriListen<number[]>(`ssh:data:${sessionId}`, (bytes) => {
            if (!disposed) term.write(new Uint8Array(bytes))
          }),
          tauriListen<string>(`ssh:close:${sessionId}`, (reason) => {
            isConnected = false
            setConnected(false)
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
          config: {
            ...asset.config,
            auth: buildSshAuth(asset.config),
            pty_cols: term.cols,
            pty_rows: term.rows,
          },
        })
        if (disposed) {
          void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
          return
        }
        isConnected = true
        setConnected(true)
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
      isConnected = false
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
        <header>
          <div className={css.headLeft}>
            <span className={css.title}>{asset.name}</span>
            <nav className={css.tabs}>
              <button
                type="button"
                className={tab === 'terminal' ? css.tabActive : ''}
                onClick={() => setTab('terminal')}
              >终端</button>
              <button
                type="button"
                className={tab === 'sftp' ? css.tabActive : ''}
                onClick={() => setTab('sftp')}
              >文件 (SFTP){connected ? '' : ' · 未连接'}</button>
            </nav>
          </div>
          <button type="button" onClick={onClose}>关闭</button>
        </header>
        {error !== null && <div className={css.error}>{error}</div>}
        {tab === 'terminal' ? (
          <div ref={host} className={css.terminal} />
        ) : (
          <div className={css.sftpHost}>
            <SftpPanel asset={asset} sessionId={asset.id} sshConnected={connected} />
          </div>
        )}
      </section>
    </div>
  )
}
