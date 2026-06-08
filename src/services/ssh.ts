import { invoke } from '@tauri-apps/api/core'
import type { AssetConfig } from '@/types/asset'

export interface SshSessionInfo {
  id: string
  host: string
  port: number
  username: string
  connected: boolean
}

export interface SshAuthConfig {
  Password?: string
  PrivateKey?: { key: string; passphrase?: string }
}

export interface SshConfig {
  host: string
  port: number
  username: string
  auth: SshAuthConfig
  jump_host?: string | null
  jump_port?: number | null
  jump_username?: string | null
  jump_auth?: SshAuthConfig | null
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
  if (config.password) return { Password: config.password }
  if (config.privateKey) return { PrivateKey: { key: config.privateKey, passphrase: config.passphrase } }
  return { Password: '' }
}

export function assetConfigToSshConfig(config: AssetConfig): SshConfig {
  const sshConfig: SshConfig = {
    host: config.host || '',
    port: config.port || 22,
    username: config.username || '',
    auth: buildAuth(config),
  }

  if (config.jumpHost) {
    sshConfig.jump_host = config.jumpHost
    sshConfig.jump_port = config.jumpPort || 22
    sshConfig.jump_username = config.jumpUsername || config.username || ''
    sshConfig.jump_auth = config.jumpPrivateKey
      ? { PrivateKey: { key: config.jumpPrivateKey, passphrase: config.jumpPassphrase } }
      : config.jumpPassword
        ? { Password: config.jumpPassword }
        : buildAuth(config)
  }

  return sshConfig
}
