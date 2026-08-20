/**
 * Shell-native SSH/SFTP terminal overlay.
 *
 * Opened in-page (no new window) when an SSH asset is clicked. Owns one xterm
 * instance connected via the StarHub interactive SSH session, and exposes a
 * second tab with the native SFTP file-transfer panel that reuses the same live
 * session. SSH terminal and SFTP inherently share one connection, so they ride
 * the same overlay.
 *
 * cwd tracking (SFTP「跟随终端」): the terminal tracks the remote cwd from the
 * PTY stream (OSC 7 + `pwd` fallback) and lazily injects an OSC 7 hook into the
 * running shell once follow is enabled and a prompt is seen, so `cd` reports
 * cwd live. The tracked `sshCwd` is handed to the SFTP panel for follow-nav.
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
import { BroadcastDialog, type BroadcastSession } from './BroadcastDialog.tsx'
import { WebBrowser } from './WebBrowser.tsx'
import {
  OSC7_INJECT_COMMAND, OSC7_INJECT_ECHO_TEXT, createCwdTracker, createHiddenEchoFilter, isShellPromptLine, parsePwdOutput,
} from './terminal-cwd.ts'
import css from './SshTerminalOverlay.module.css'

/** Props for one native SSH/SFTP terminal overlay. */
export interface SshTerminalOverlayProps {
  asset: RustAsset
  onClose: () => void
}

type OverlayTab = 'terminal' | 'sftp' | 'web'

/**
 * Build the Rust `SshAuth` variant from an asset config, mirroring the Vue
 * `buildAuth` (src/services/ssh.ts): password / private key / both, with the
 * usePasswordAuth / useKeyAuth flags.
 * @param config - the hydrated asset config.
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
 * Render one xterm instance backed by a StarHub interactive SSH session, with
 * cwd tracking for the SFTP follow-terminal flow.
 * @param props - selected SSH asset and overlay close callback.
 * @returns the native SSH/SFTP terminal overlay.
 */
export function SshTerminalOverlay({ asset, onClose }: SshTerminalOverlayProps) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [tab, setTab] = useState<OverlayTab>('terminal')
  const [sshCwd, setSshCwd] = useState('')
  // 命令广播(需求 6 broadcast 子集):弹层会话列表 + 发送结果提示。
  const [broadcastSessions, setBroadcastSessions] = useState<BroadcastSession[] | null>(null)
  const [broadcastNotice, setBroadcastNotice] = useState<string | null>(null)

  const sessionId = asset.id
  // cwd / injection state shared between the effect and the follow callback.
  const isConnectedRef = useRef(false)
  const osc7InjectPendingRef = useRef(false)
  const osc7InjectedRef = useRef(false)
  const shellPromptSeenRef = useRef(false)
  const cwdRef = useRef('')
  const disposedRef = useRef(false)

  const applyCwd = (next: string) => {
    if (!next || next === cwdRef.current) return
    cwdRef.current = next
    if (!disposedRef.current) setSshCwd(next)
  }

  /** Lazily inject the OSC 7 hook after the shell reaches a prompt. */
  const tryInjectOsc7 = () => {
    if (!osc7InjectPendingRef.current || osc7InjectedRef.current || !isConnectedRef.current) return
    osc7InjectPendingRef.current = false
    osc7InjectedRef.current = true
    void tauriInvoke('ssh_write', { id: sessionId, data: OSC7_INJECT_COMMAND }).catch(() => {
      // allow a later retry on the next follow toggle
      osc7InjectedRef.current = false
      osc7InjectPendingRef.current = true
    })
  }

  /** SFTP「跟随终端」toggle → request OSC 7 injection (once, after prompt). */
  const onFollowTerminal = (enabled: boolean) => {
    if (!enabled || osc7InjectedRef.current || disposedRef.current) return
    osc7InjectPendingRef.current = true
    if (shellPromptSeenRef.current) tryInjectOsc7()
  }

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

    let disposed = false
    disposedRef.current = false
    let resizeObserver: ResizeObserver | undefined
    let unlistenData: TauriUnlisten | undefined
    let unlistenClose: TauriUnlisten | undefined

    const cwdTracker = createCwdTracker()
    const decoder = new TextDecoder()
    const hiddenEcho = createHiddenEchoFilter([OSC7_INJECT_ECHO_TEXT])

    const input = term.onData((data) => {
      if (isConnectedRef.current) void tauriInvoke('ssh_write', { id: sessionId, data }).catch(() => {})
    })

    const resize = () => {
      addon.fit()
      if (isConnectedRef.current) void tauriInvoke('ssh_resize', { id: sessionId, cols: term.cols, rows: term.rows }).catch(() => {})
    }

    /** Handle one decoded terminal chunk: render + track cwd + detect prompt. */
    const handleChunk = (chunk: string) => {
      if (!chunk) return
      const visible = hiddenEcho(chunk)
      if (visible) term.write(visible)
      const next = cwdTracker.onChunk(chunk)
      if (next !== null) applyCwd(next)
      if (!shellPromptSeenRef.current) {
        const lastLine = chunk.split('\n').pop() ?? ''
        if (isShellPromptLine(lastLine.trimEnd())) shellPromptSeenRef.current = true
      } else if (osc7InjectPendingRef.current) {
        tryInjectOsc7()
      }
    }

    /** Initialize cwd from a silent exec `pwd` (login dir) right after connect. */
    const initCwdFromExec = async () => {
      if (disposed) return
      try {
        const out = await tauriInvoke<string>('ssh_exec', { id: sessionId, command: 'pwd', timeoutSec: 5 })
        const cwd = parsePwdOutput(out)
        // OSC 7 may have reported a fresher dir; only fill when empty
        if (cwd !== null && cwdRef.current === '') applyCwd(cwd)
      } catch { /* fall back to later OSC 7 / pwd parsing */ }
    }

    const connect = async () => {
      try {
        [unlistenData, unlistenClose] = await Promise.all([
          tauriListen<number[]>(`ssh:data:${sessionId}`, (bytes) => {
            term.write(new Uint8Array(bytes))
            handleChunk(decoder.decode(new Uint8Array(bytes), { stream: true }))
          }),
          tauriListen<string>(`ssh:close:${sessionId}`, (reason) => {
            isConnectedRef.current = false
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
        isConnectedRef.current = true
        setConnected(true)
        resizeObserver = new ResizeObserver(resize)
        if (host.current !== null) resizeObserver.observe(host.current)
        resize()
        term.focus()
        void initCwdFromExec()
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught))
      }
    }

    void connect()
    return () => {
      disposed = true
      disposedRef.current = true
      isConnectedRef.current = false
      input.dispose()
      resizeObserver?.disconnect()
      void unlistenData?.()
      void unlistenClose?.()
      const tail = decoder.decode()
      if (tail) handleChunk(tail)
      void tauriInvoke('ssh_disconnect', { id: sessionId }).catch(() => {})
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset])

  /** 打开广播弹层:拉取所有已连接的 SSH 会话作为目标列表。 */
  const openBroadcast = async (): Promise<void> => {
    setBroadcastNotice(null)
    try {
      const infos = await tauriInvoke<Array<{ id: string; host?: string; port?: number; username?: string; connected?: boolean }>>('ssh_get_sessions')
      const sessions: BroadcastSession[] = (infos ?? [])
        .filter((s) => s.connected === true)
        .map((s) => {
          const endpoint = `${s.username ?? ''}@${s.host ?? ''}:${s.port ?? 22}`
          return { sessionId: s.id, title: s.id, host: endpoint }
        })
      if (sessions.length === 0) {
        setBroadcastNotice('没有已连接的会话可用于广播')
        return
      }
      setBroadcastSessions(sessions)
    } catch (e) {
      setBroadcastNotice(e instanceof Error ? e.message : String(e))
    }
  }

  /** 关闭广播弹层。 */
  const closeBroadcast = (): void => setBroadcastSessions(null)

  /** 把命令写入每个选中的会话(逐会话容错;提示成功/失败计数)。 */
  const sendBroadcast = async (command: string, sessionIds: string[]): Promise<void> => {
    let failed = 0
    for (const sid of sessionIds) {
      try {
        await tauriInvoke('ssh_write', { id: sid, data: `${command}\n` })
      } catch {
        failed += 1
      }
    }
    closeBroadcast()
    setBroadcastNotice(failed === 0
      ? `已广播到 ${sessionIds.length} 个会话`
      : `广播完成,${failed} 个会话发送失败`)
  }

  return (
    <div className={css.backdrop}>
      <section className={css.panel} aria-label={`SSH 终端 ${asset.name}`}>
        <header>
          <div className={css.headLeft}>
            <span className={connected ? css.statusOnline : css.statusPending} aria-label={connected ? 'SSH 已连接' : 'SSH 连接中'} />
            <div className={css.identity}>
              <span className={css.title}>{asset.name}</span>
              <span className={css.endpoint}>{typeof asset.config.username === 'string' ? `${asset.config.username}@` : ''}{typeof asset.config.host === 'string' ? asset.config.host : '未配置主机'}</span>
            </div>
            <nav className={css.tabs} aria-label="SSH 工作区">
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
              <button
                type="button"
                className={tab === 'web' ? css.tabActive : ''}
                onClick={() => setTab('web')}
                title="经 SSH 网关访问网页"
              >网页</button>
            </nav>
          </div>
          <div className={css.headRight}>
            <button
              type="button"
              className={css.textAction}
              onClick={() => void openBroadcast()}
              title="命令广播:把同一命令发送到多个已连接 SSH 会话"
            >广播</button>
            <button type="button" className={css.iconButton} onClick={onClose} title="关闭工作区" aria-label="关闭工作区">×</button>
          </div>
        </header>
        {error !== null && <div className={css.error}>{error}</div>}
        {broadcastNotice !== null && (
          <div className={css.notice} role="status">{broadcastNotice}<button type="button" className={css.noticeClose} onClick={() => setBroadcastNotice(null)}>×</button></div>
        )}
        {tab === 'terminal' ? (
          <div ref={host} className={css.terminal} />
        ) : tab === 'web' ? (
          <div className={css.webHost}>
            <WebBrowser sessionId={sessionId} assetName={asset.name} />
          </div>
        ) : (
          <div className={css.sftpHost}>
            <SftpPanel
              asset={asset}
              sessionId={sessionId}
              sshConnected={connected}
              sshCwd={sshCwd}
              onFollowTerminal={onFollowTerminal}
            />
          </div>
        )}
      </section>
      {broadcastSessions !== null && (
        <BroadcastDialog
          sessions={broadcastSessions}
          onSubmit={({ command, sessionIds }) => void sendBroadcast(command, sessionIds)}
          onClose={closeBroadcast}
        />
      )}
    </div>
  )
}
