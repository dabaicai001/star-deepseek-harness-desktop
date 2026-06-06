import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DockerSession, ContainerInfo, ImageInfo, ContainerStats, LogEntry } from '@/types/docker'
import * as dockerService from '@/services/docker'

export const useDockerStore = defineStore('docker', () => {
  const sessions = ref<Map<string, DockerSession>>(new Map())
  const currentConnId = ref<string | null>(null)
  const containers = ref<ContainerInfo[]>([])
  const images = ref<ImageInfo[]>([])
  const selectedContainerId = ref<string | null>(null)
  const containerStatsMap = ref<Map<string, ContainerStats>>(new Map())
  const containerLogs = ref<LogEntry[]>([])
  const isLoading = ref(false)
  const showAllContainers = ref(true)

  const currentSession = computed(() => {
    if (!currentConnId.value) return null
    return sessions.value.get(currentConnId.value) || null
  })

  const selectedContainer = computed(() => {
    if (!selectedContainerId.value) return null
    return containers.value.find(c => c.id === selectedContainerId.value) || null
  })

  const runningContainers = computed(() => containers.value.filter(c => c.state === 'running'))
  const stoppedContainers = computed(() => containers.value.filter(c => c.state !== 'running'))

  async function connect(assetId: string, name: string, params: { host?: string }): Promise<DockerSession> {
    const info = await dockerService.dockerConnect(params)
    const session: DockerSession = {
      connId: info.connId,
      host: info.host || 'local',
      connected: true,
      name,
      assetId
    }
    sessions.value.set(info.connId, session)
    currentConnId.value = info.connId
    return session
  }

  async function disconnect(connId: string) {
    try {
      await dockerService.dockerDisconnect(connId)
    } catch { /* ignore */ }
    sessions.value.delete(connId)
    if (currentConnId.value === connId) {
      currentConnId.value = sessions.value.size > 0 ? sessions.value.keys().next().value ?? null : null
    }
  }

  async function loadContainers() {
    if (!currentConnId.value) return
    isLoading.value = true
    try {
      containers.value = await dockerService.listContainers(currentConnId.value, showAllContainers.value)
    } catch (err) {
      console.error('Load containers failed:', err)
    } finally {
      isLoading.value = false
    }
  }

  async function loadImages() {
    if (!currentConnId.value) return
    try {
      images.value = await dockerService.listImages(currentConnId.value)
    } catch (err) {
      console.error('Load images failed:', err)
    }
  }

  async function startContainer(containerId: string) {
    if (!currentConnId.value) return
    await dockerService.startContainer(currentConnId.value, containerId)
    await loadContainers()
  }

  async function stopContainer(containerId: string) {
    if (!currentConnId.value) return
    await dockerService.stopContainer(currentConnId.value, containerId)
    await loadContainers()
  }

  async function restartContainer(containerId: string) {
    if (!currentConnId.value) return
    await dockerService.restartContainer(currentConnId.value, containerId)
    await loadContainers()
  }

  async function removeContainer(containerId: string, force?: boolean) {
    if (!currentConnId.value) return
    await dockerService.removeContainer(currentConnId.value, containerId, force)
    if (selectedContainerId.value === containerId) {
      selectedContainerId.value = null
    }
    await loadContainers()
  }

  async function loadContainerLogs(containerId: string, tail?: string) {
    if (!currentConnId.value) return
    try {
      containerLogs.value = await dockerService.containerLogs(currentConnId.value, containerId, tail)
    } catch (err) {
      console.error('Load logs failed:', err)
    }
  }

  async function loadContainerStats(containerId: string) {
    if (!currentConnId.value) return
    try {
      const stats = await dockerService.containerStats(currentConnId.value, containerId)
      containerStatsMap.value.set(containerId, stats)
    } catch (err) {
      console.error('Load stats failed:', err)
    }
  }

  function selectContainer(containerId: string | null) {
    selectedContainerId.value = containerId
  }

  return {
    sessions,
    currentConnId,
    containers,
    images,
    selectedContainerId,
    containerStatsMap,
    containerLogs,
    isLoading,
    showAllContainers,
    currentSession,
    selectedContainer,
    runningContainers,
    stoppedContainers,
    connect,
    disconnect,
    loadContainers,
    loadImages,
    startContainer,
    stopContainer,
    restartContainer,
    removeContainer,
    loadContainerLogs,
    loadContainerStats,
    selectContainer
  }
})
