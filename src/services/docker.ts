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

export async function dockerConnect(params: DockerConnectParams): Promise<DockerConnectionInfo> {
  return invoke('docker_connect', { params })
}

export async function dockerTest(params: DockerConnectParams): Promise<TestResult> {
  return invoke('docker_test', { params })
}

export async function dockerDisconnect(connId: string): Promise<void> {
  return invoke('docker_disconnect', { connId })
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
  return invoke('docker_list_containers', { connId, all })
}

export async function inspectContainer(connId: string, containerId: string): Promise<Record<string, unknown>> {
  return invoke('docker_inspect_container', { connId, containerId })
}

export async function startContainer(connId: string, containerId: string): Promise<void> {
  return invoke('docker_start_container', { connId, containerId })
}

export async function stopContainer(connId: string, containerId: string, timeout?: number): Promise<void> {
  return invoke('docker_stop_container', { connId, containerId, timeout })
}

export async function restartContainer(connId: string, containerId: string, timeout?: number): Promise<void> {
  return invoke('docker_restart_container', { connId, containerId, timeout })
}

export async function removeContainer(connId: string, containerId: string, force?: boolean): Promise<void> {
  return invoke('docker_remove_container', { connId, containerId, force })
}

export async function containerLogs(connId: string, containerId: string, tail?: string): Promise<LogEntry[]> {
  return invoke('docker_container_logs', { connId, containerId, tail })
}

export async function containerStats(connId: string, containerId: string): Promise<ContainerStats> {
  return invoke('docker_container_stats', { connId, containerId })
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
  return invoke('docker_list_images', { connId, all })
}

export async function pullImage(connId: string, imageName: string): Promise<{ result: string }> {
  return invoke('docker_pull_image', { connId, imageName })
}

export async function removeImage(connId: string, imageId: string, force?: boolean): Promise<void> {
  return invoke('docker_remove_image', { connId, imageId, force })
}

export async function pruneImages(connId: string): Promise<void> {
  return invoke('docker_prune_images', { connId })
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
  return invoke('docker_exec', {
    connId,
    containerId,
    command,
    workdir: options?.workdir,
    timeoutSec: options?.timeoutSec
  })
}
