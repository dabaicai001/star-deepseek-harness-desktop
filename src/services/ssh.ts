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
