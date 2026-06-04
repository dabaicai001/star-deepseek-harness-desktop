import { invoke } from '@tauri-apps/api/core'
import type { AssetConfig } from '@/types/asset'

export interface SshSessionInfo {
  id: string
  host: string
  port: number
  username: string
  connected: boolean
}

export interface SshConfig {
  host: string
  port: number
  username: string
  auth: {
    Password?: string
    PrivateKey?: { key: string; passphrase?: string }
  }
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

export function assetConfigToSshConfig(config: AssetConfig): SshConfig {
  return {
    host: config.host || '',
    port: config.port || 22,
    username: config.username || '',
    auth: config.password
      ? { Password: config.password }
      : config.privateKey
        ? { PrivateKey: { key: config.privateKey, passphrase: config.passphrase } }
        : { Password: '' }
  }
}
