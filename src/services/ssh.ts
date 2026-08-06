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
  pty_cols?: number | null
  pty_rows?: number | null
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

/** 为一次性命令建立无 PTY / 无远端 shell 的 SSH 会话。 */
export async function sshConnectExec(id: string, config: SshConfig): Promise<SshSessionInfo> {
  return invoke('ssh_connect_exec', { id, config })
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
 * - `execId` 可选;传入后可用 `sshExecAbort` 中断本次执行
 */
export async function sshExec(
  id: string,
  command: string,
  timeoutSec?: number,
  execId?: string
): Promise<string> {
  return invoke('ssh_exec', { id, command, timeoutSec, execId })
}

/**
 * 中断一个仍在执行的 ssh_exec 命令(通过 execId 定位)。
 * 远端 channel 被关闭,对应 sshExec 会以 [EXEC_ABORTED] 错误返回已收到的部分输出。
 */
export async function sshExecAbort(id: string, execId: string): Promise<boolean> {
  return invoke('ssh_exec_abort', { id, execId })
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

// ─── 端口转发 ───

export interface PortForwardInfo {
  forward_type: string
  bound_port: number
  target_host: string
  target_port: number
}

export async function sshAddLocalForward(
  id: string,
  localPort: number,
  remoteHost: string,
  remotePort: number
): Promise<number> {
  return invoke('ssh_add_local_forward', { id, localPort, remoteHost, remotePort })
}

/**
 * Web 代理转发:与 sshAddLocalForward 相同建立 127.0.0.1 本地监听,
 * 但会把首个 HTTP 请求的 Host 头改写为 remoteHost:remotePort,
 * 修复浏览器经 127.0.0.1 访问虚拟主机 / Ingress 站点返回 404 的问题。
 */
export async function sshAddWebProxyForward(
  id: string,
  localPort: number,
  remoteHost: string,
  remotePort: number
): Promise<number> {
  return invoke('ssh_add_web_proxy_forward', { id, localPort, remoteHost, remotePort })
}

export async function sshAddRemoteForward(
  id: string,
  remotePort: number,
  localHost: string,
  localPort: number
): Promise<number> {
  return invoke('ssh_add_remote_forward', { id, remotePort, localHost, localPort })
}

export async function sshRemoveForward(
  id: string,
  boundPort: number,
  isRemote: boolean
): Promise<void> {
  return invoke('ssh_remove_forward', { id, boundPort, isRemote })
}

export async function sshListForwards(id: string): Promise<PortForwardInfo[]> {
  return invoke('ssh_list_forwards', { id })
}

// ─── Web 网关(经服务器访问网页) ───

export async function sshStartWebGateway(id: string): Promise<number> {
  return invoke('ssh_start_web_gateway', { sessionId: id })
}

export async function sshStopWebGateway(id: string): Promise<void> {
  return invoke('ssh_stop_web_gateway', { sessionId: id })
}

export async function sshWebGatewayPort(id: string): Promise<number | null> {
  return invoke('ssh_web_gateway_port', { sessionId: id })
}

// ─── SSH Config 导入 ───

export interface SshConfigHost {
  name: string
  host?: string
  port?: number
  user?: string
  identity_file?: string
  proxy_jump?: string
}

export async function parseSshConfigFile(configPath?: string): Promise<SshConfigHost[]> {
  return invoke('ssh_parse_config_file', { configPath: configPath ?? null })
}
