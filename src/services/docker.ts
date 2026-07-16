import { invoke } from '@tauri-apps/api/core'
import type {
  DockerConnectParams,
  DockerConnectionInfo,
  TestResult,
  ContainerInfo,
  ContainerStats,
  ImageInfo,
  LogEntry
} from '@/types/docker'

/**
 * 统一包装 invoke 错误,生成面向用户可读的错误信息。
 * 返回类型为 never,调用方在 catch 块中调用后 TypeScript 会自动收窄类型。
 */
function wrapInvokeError(operation: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  throw new Error(`[Docker] ${operation} 失败: ${message}`)
}

export async function dockerConnect(params: DockerConnectParams): Promise<DockerConnectionInfo> {
  try {
    return await invoke('docker_connect', { params })
  } catch (error) {
    wrapInvokeError('docker_connect', error)
  }
}

export async function dockerTest(params: DockerConnectParams): Promise<TestResult> {
  try {
    return await invoke('docker_test', { params })
  } catch (error) {
    wrapInvokeError('docker_test', error)
  }
}

export async function dockerDisconnect(connId: string): Promise<void> {
  try {
    return await invoke('docker_disconnect', { connId })
  } catch (error) {
    wrapInvokeError('docker_disconnect', error)
  }
}

export async function listContainers(connId: string, all?: boolean): Promise<ContainerInfo[]> {
  if (import.meta.env.DEV && connId === 'mock-docker-conn') {
    return [
      {
        id: 'mock-api-container',
        name: 'starhub-api',
        image: 'ghcr.io/starhub/api:latest',
        state: 'running',
        status: 'Up 3 hours (healthy)',
        created: Math.floor(Date.now() / 1000) - 10800,
        ports: [{ private: 8080, public: 8080, type: 'tcp' }],
        labels: { 'com.docker.compose.service': 'api' },
      },
      {
        id: 'mock-worker-container',
        name: 'starhub-worker',
        image: 'ghcr.io/starhub/worker:latest',
        state: 'running',
        status: 'Up 3 hours',
        created: Math.floor(Date.now() / 1000) - 10600,
        ports: [],
        labels: { 'com.docker.compose.service': 'worker' },
      },
      {
        id: 'mock-old-container',
        name: 'starhub-migrate',
        image: 'ghcr.io/starhub/api:latest',
        state: 'exited',
        status: 'Exited (0) 3 hours ago',
        created: Math.floor(Date.now() / 1000) - 11200,
        ports: [],
        labels: {},
      },
    ]
  }
  try {
    return await invoke('docker_list_containers', { connId, all })
  } catch (error) {
    wrapInvokeError('docker_list_containers', error)
  }
}

export async function inspectContainer(connId: string, containerId: string): Promise<Record<string, unknown>> {
  try {
    return await invoke('docker_inspect_container', { connId, containerId })
  } catch (error) {
    wrapInvokeError('docker_inspect_container', error)
  }
}

export async function startContainer(connId: string, containerId: string): Promise<void> {
  try {
    return await invoke('docker_start_container', { connId, containerId })
  } catch (error) {
    wrapInvokeError('docker_start_container', error)
  }
}

export async function stopContainer(connId: string, containerId: string, timeout?: number): Promise<void> {
  try {
    return await invoke('docker_stop_container', { connId, containerId, timeout })
  } catch (error) {
    wrapInvokeError('docker_stop_container', error)
  }
}

export async function restartContainer(connId: string, containerId: string, timeout?: number): Promise<void> {
  try {
    return await invoke('docker_restart_container', { connId, containerId, timeout })
  } catch (error) {
    wrapInvokeError('docker_restart_container', error)
  }
}

export async function removeContainer(connId: string, containerId: string, force?: boolean): Promise<void> {
  try {
    return await invoke('docker_remove_container', { connId, containerId, force })
  } catch (error) {
    wrapInvokeError('docker_remove_container', error)
  }
}

export async function containerLogs(connId: string, containerId: string, tail?: string): Promise<LogEntry[]> {
  try {
    return await invoke('docker_container_logs', { connId, containerId, tail })
  } catch (error) {
    wrapInvokeError('docker_container_logs', error)
  }
}

export async function containerStats(connId: string, containerId: string): Promise<ContainerStats> {
  try {
    return await invoke('docker_container_stats', { connId, containerId })
  } catch (error) {
    wrapInvokeError('docker_container_stats', error)
  }
}

export async function listImages(connId: string, all?: boolean): Promise<ImageInfo[]> {
  if (import.meta.env.DEV && connId === 'mock-docker-conn') {
    return [{
      id: 'sha256:mock-starhub-api',
      tags: ['ghcr.io/starhub/api:latest'],
      size: 186646528,
      created: Math.floor(Date.now() / 1000) - 86400,
    }]
  }
  try {
    return await invoke('docker_list_images', { connId, all })
  } catch (error) {
    wrapInvokeError('docker_list_images', error)
  }
}

export async function pullImage(connId: string, imageName: string): Promise<{ result: string }> {
  try {
    return await invoke('docker_pull_image', { connId, imageName })
  } catch (error) {
    wrapInvokeError('docker_pull_image', error)
  }
}

export async function removeImage(connId: string, imageId: string, force?: boolean): Promise<void> {
  try {
    return await invoke('docker_remove_image', { connId, imageId, force })
  } catch (error) {
    wrapInvokeError('docker_remove_image', error)
  }
}

export async function pruneImages(connId: string): Promise<void> {
  try {
    return await invoke('docker_prune_images', { connId })
  } catch (error) {
    wrapInvokeError('docker_prune_images', error)
  }
}

/** 在指定容器内执行命令,返回 stdout + stderr */
export interface DockerExecResult {
  stdout: string
  stderr: string
  exitCode: number
}
export async function dockerExec(
  connId: string,
  containerId: string,
  command: string[],
  options?: { workdir?: string; timeoutSec?: number }
): Promise<DockerExecResult> {
  if (import.meta.env.DEV && connId === 'mock-docker-conn') {
    const shellCommand = command[2]?.trim() ?? command.join(' ')
    if (shellCommand.includes('cd') && shellCommand.includes('pwd')) {
      const target = command.length > 3 ? command.at(-1) ?? '/root' : '/root'
      const base = target.startsWith('/') ? target : `${options?.workdir || '/'}/${target}`
      const resolved = base.split('/').reduce<string[]>((parts, part) => {
        if (!part || part === '.') return parts
        if (part === '..') parts.pop()
        else parts.push(part)
        return parts
      }, [])
      return { stdout: `/${resolved.join('/')}\n`, stderr: '', exitCode: 0 }
    }
    const outputs: Record<string, string> = {
      'ps aux': 'PID   USER     TIME  COMMAND\n1     root     0:01  /app/starhub-api\n37    root     0:00  sh -c ps aux\n',
      'ls -la': 'total 28\ndrwxr-xr-x    1 root root 4096 Jul 13 04:20 .\ndrwxr-xr-x    1 root root 4096 Jul 13 04:20 ..\ndrwxr-xr-x    2 root root 4096 Jul 13 04:20 app\ndrwxr-xr-x    1 root root 4096 Jul 13 04:20 etc\n',
      'df -h': 'Filesystem      Size  Used Avail Use% Mounted on\noverlay          40G   12G   28G  30% /\n',
      'cat /etc/hosts': '127.0.0.1 localhost\n172.18.0.3 starhub-api\n',
      pwd: `${options?.workdir || '/'}\n`,
    }
    const echoMatch = shellCommand.match(/^echo\s+(.+)$/)
    return {
      stdout: outputs[shellCommand] ?? (echoMatch ? `${echoMatch[1]}\n` : `mock: ${shellCommand}\n`),
      stderr: '',
      exitCode: 0,
    }
  }
  try {
    return await invoke('docker_exec', {
      connId,
      containerId,
      command,
      workdir: options?.workdir,
      timeoutSec: options?.timeoutSec
    })
  } catch (error) {
    wrapInvokeError('docker_exec', error)
  }
}

/** 持久交互式容器 Shell 的创建结果。 */
export interface DockerExecSessionStartResult {
  sessionId: string
}

/** 一次长轮询拿到的容器终端字节(base64)与进程状态。 */
export interface DockerExecSessionReadResult {
  data: string
  running: boolean
  exitCode?: number
  error?: string
}

type MockDockerExecSession = {
  name: string
  cwd: string
  input: string
  output: string
  running: boolean
  exitCode?: number
}

const mockDockerExecSessions = new Map<string, MockDockerExecSession>()
let mockDockerExecSessionCounter = 0

function isMockDockerConnection(connId: string): boolean {
  return import.meta.env.DEV && connId === 'mock-docker-conn'
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function mockDockerPrompt(session: MockDockerExecSession): string {
  return `root@${session.name}:${session.cwd}# `
}

function mockDockerCommand(session: MockDockerExecSession, command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  if (trimmed === 'exit' || trimmed === 'logout') {
    session.running = false
    session.exitCode = 0
    return 'logout\r\n'
  }
  if (trimmed === 'pwd') return `${session.cwd}\r\n`
  if (trimmed.startsWith('cd ')) {
    const target = trimmed.slice(3).trim()
    session.cwd = target.startsWith('/') ? target : `${session.cwd.replace(/\/$/, '')}/${target}`
    return ''
  }
  const outputs: Record<string, string> = {
    'ps aux': 'PID   USER     TIME  COMMAND\r\n1     root     0:01  /app/starhub-api\r\n42    root     0:00  bash -il\r\n',
    'ls -la': 'total 28\r\ndrwxr-xr-x 1 root root 4096 Jul 13 04:20 .\r\ndrwxr-xr-x 1 root root 4096 Jul 13 04:20 ..\r\ndrwxr-xr-x 2 root root 4096 Jul 13 04:20 app\r\n',
    'df -h': 'Filesystem      Size  Used Avail Use% Mounted on\r\noverlay          40G   12G   28G  30% /\r\n',
    'cat /etc/hosts': `127.0.0.1 localhost\r\n172.18.0.3 ${session.name}\r\n`,
  }
  return outputs[trimmed] ?? `/bin/bash: ${trimmed}: command not found\r\n`
}

/** 进入容器并建立带 TTY 的持久交互式 Shell。 */
export async function dockerExecSessionStart(
  connId: string,
  containerId: string,
  cols = 120,
  rows = 30
): Promise<DockerExecSessionStartResult> {
  if (isMockDockerConnection(connId)) {
    const sessionId = `mock-docker-exec-${++mockDockerExecSessionCounter}`
    const name = containerId === 'mock-worker-container' ? 'starhub-worker' : 'starhub-api'
    const session: MockDockerExecSession = {
      name,
      cwd: '/',
      input: '',
      output: '',
      running: true,
    }
    session.output = `\x1b[32m${mockDockerPrompt(session)}\x1b[0m`
    mockDockerExecSessions.set(sessionId, session)
    return { sessionId }
  }
  try {
    return await invoke('docker_exec_session_start', { connId, containerId, cols, rows })
  } catch (error) {
    wrapInvokeError('docker_exec_session_start', error)
  }
}

/** 长轮询读取交互式 Shell 输出。 */
export async function dockerExecSessionRead(
  connId: string,
  sessionId: string,
  waitMs = 1000
): Promise<DockerExecSessionReadResult> {
  if (isMockDockerConnection(connId)) {
    const session = mockDockerExecSessions.get(sessionId)
    if (!session) throw new Error(`Docker exec session not found: ${sessionId}`)
    if (!session.output && session.running) {
      await new Promise(resolve => window.setTimeout(resolve, Math.min(waitMs, 100)))
    }
    const output = session.output
    session.output = ''
    return {
      data: encodeBase64(output),
      running: session.running,
      exitCode: session.exitCode,
    }
  }
  try {
    return await invoke('docker_exec_session_read', { connId, sessionId, waitMs })
  } catch (error) {
    wrapInvokeError('docker_exec_session_read', error)
  }
}

/** 把 xterm 输入原样写入容器 Shell。 */
export async function dockerExecSessionWrite(connId: string, sessionId: string, data: string): Promise<void> {
  if (isMockDockerConnection(connId)) {
    const session = mockDockerExecSessions.get(sessionId)
    if (!session || !session.running) throw new Error(`Docker exec session is not running: ${sessionId}`)
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        session.output += `\r\n${mockDockerCommand(session, session.input)}`
        session.input = ''
        if (session.running) session.output += mockDockerPrompt(session)
      } else if (char === '\x03') {
        session.input = ''
        session.output += '^C\r\n' + mockDockerPrompt(session)
      } else if (char === '\x0c') {
        session.output += '\x1b[2J\x1b[H' + mockDockerPrompt(session) + session.input
      } else if (char === '\x7f' || char === '\b') {
        if (session.input) {
          session.input = Array.from(session.input).slice(0, -1).join('')
          session.output += '\b \b'
        }
      } else if (char === '\t') {
        if (session.input === 'p') {
          session.input = 'pwd'
          session.output += 'wd'
        }
      } else if (char >= ' ' && char !== '\x7f') {
        session.input += char
        session.output += char
      }
    }
    return
  }
  try {
    return await invoke('docker_exec_session_write', { connId, sessionId, data })
  } catch (error) {
    wrapInvokeError('docker_exec_session_write', error)
  }
}

/** 同步容器 TTY 尺寸。 */
export async function dockerExecSessionResize(
  connId: string,
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  if (isMockDockerConnection(connId)) return
  try {
    return await invoke('docker_exec_session_resize', { connId, sessionId, cols, rows })
  } catch (error) {
    wrapInvokeError('docker_exec_session_resize', error)
  }
}

/** 关闭交互式容器 Shell。 */
export async function dockerExecSessionClose(connId: string, sessionId: string): Promise<void> {
  if (isMockDockerConnection(connId)) {
    mockDockerExecSessions.delete(sessionId)
    return
  }
  try {
    return await invoke('docker_exec_session_close', { connId, sessionId })
  } catch (error) {
    wrapInvokeError('docker_exec_session_close', error)
  }
}
