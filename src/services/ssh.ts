import { invoke } from '@tauri-apps/api/core'
import type { AssetConfig, SftpLaunchMode } from '@/types/asset'

export interface SshSessionInfo {
  id: string
  host: string
  port: number
  username: string
  connected: boolean
}

export interface SshAuthPassword {
  Password: string
}

export interface SshAuthPrivateKey {
  PrivateKey: { key: string; passphrase?: string | null }
}

export interface SshAuthPasswordAndKey {
  PasswordAndKey: { password: string; key: string; passphrase?: string | null }
}

export type SshAuthConfig = SshAuthPassword | SshAuthPrivateKey | SshAuthPasswordAndKey

export interface KeyboardInteractiveConfig {
  enabled: boolean
  password?: string | null
}

export interface SshConfig {
  host: string
  port: number
  username: string
  auth: SshAuthConfig
  sftp_timeout_sec?: number
  sftp_launch_mode?: SftpLaunchMode
  sftp_server_path?: string | null
  kb_interactive?: KeyboardInteractiveConfig | null
  jump_host?: string | null
  jump_port?: number | null
  jump_username?: string | null
  jump_auth?: SshAuthConfig | null
}

export interface KbInteractiveEvent {
  instructions: string
  prompts: Array<{ prompt: string; echo: boolean }>
  autoFill: Array<string | null>
}

export async function sshConnect(id: string, config: SshConfig): Promise<SshSessionInfo> {
  return invoke('ssh_connect', { id, config })
}

export async function sshDisconnect(id: string): Promise<void> {
  return invoke('ssh_disconnect', { id })
}

export async function sshWrite(id: string, data: string): Promise<void> {
  return invoke('ssh_write', { id, data })
}

export async function sshResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke('ssh_resize', { id, cols, rows })
}

export async function sshGetSessions(): Promise<SshSessionInfo[]> {
  return invoke('ssh_get_sessions')
}

/**
 * 在已有 SSH 会话上跑一条命令,返回 stdout。
 * 给仪表盘 / 一次性数据采集用(系统指标、配置查询等)。
 * - `timeoutSec` 默认 10 秒,内部强制 >=1
 * - 非 0 退出码会 throw
 */
export async function sshExec(
  id: string,
  command: string,
  timeoutSec?: number
): Promise<string> {
  return invoke('ssh_exec', { id, command, timeoutSec })
}

function buildAuth(config: AssetConfig): SshAuthConfig {
  const usePassword = config.usePasswordAuth !== false
  const useKey = config.useKeyAuth === true

  if (usePassword && useKey && config.password && config.privateKey) {
    return { PasswordAndKey: { password: config.password, key: config.privateKey, passphrase: config.passphrase ?? null } }
  }
  if (config.password && usePassword) return { Password: config.password }
  if (config.privateKey && useKey) return { PrivateKey: { key: config.privateKey, passphrase: config.passphrase ?? null } }
  return { Password: '' }
}

export function assetConfigToSshConfig(config: AssetConfig): SshConfig {
  const sshConfig: SshConfig = {
    host: config.host || '',
    port: config.port || 22,
    username: config.username || '',
    auth: buildAuth(config),
    sftp_timeout_sec: config.sftpTimeoutSec ?? 30,
    sftp_launch_mode: config.sftpLaunchMode ?? 'auto',
    sftp_server_path: config.sftpServerPath || null,
    kb_interactive: config.mfaEnabled
      ? {
          enabled: true,
          password: config.mfaPassword ?? null,
        }
      : null,
  }

  if (config.jumpHost) {
    sshConfig.jump_host = config.jumpHost
    sshConfig.jump_port = config.jumpPort || 22
    sshConfig.jump_username = config.jumpUsername || config.username || ''
    sshConfig.jump_auth = config.jumpPrivateKey
      ? { PrivateKey: { key: config.jumpPrivateKey, passphrase: config.jumpPassphrase ?? null } }
      : config.jumpPassword
        ? { Password: config.jumpPassword }
        : buildAuth(config)
  }

  return sshConfig
}

export async function respondKeyboardInteractive(
  id: string,
  responses: string[]
): Promise<void> {
  return invoke('ssh_kb_response', { id, responses })
}
