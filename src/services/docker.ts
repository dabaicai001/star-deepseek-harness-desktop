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
  return invoke('docker_exec', {
    connId,
    containerId,
    command,
    workdir: options?.workdir,
    timeoutSec: options?.timeoutSec
  })
}
