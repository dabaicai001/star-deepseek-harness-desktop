import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { FileEntry, SftpSessionInfo, TransferTask, TransferProgress } from '../services/sftp'
import {
  sftpConnect,
  sftpDisconnect,
  sftpListDir,
  sftpMkdir,
  sftpRename,
  sftpDelete,
  sftpUpload,
  sftpDownload,
  sftpCancelTransfer,
  sftpListTransfers,
  sftpSetPermissions,
  sftpSearch
} from '../services/sftp'

export const useSftpStore = defineStore('sftp', () => {
  // State
  const sessions = ref<Map<string, SftpSessionInfo>>(new Map())
  const localPath = ref('/')
  const remotePath = ref('/')
  const localFiles = ref<FileEntry[]>([])
  const remoteFiles = ref<FileEntry[]>([])
  const transfers = ref<TransferTask[]>([])
  const searchResults = ref<FileEntry[]>([])
  const isSearching = ref(false)
  const loading = ref({ local: false, remote: false })

  // Computed
  const currentSessionId = computed(() => {
    for (const [id, session] of sessions.value) {
      if (session.connected) return id
    }
    return null
  })

  // Actions
  async function connect(sessionId: string) {
    const session = await sftpConnect(sessionId)
    sessions.value.set(sessionId, session)
    remotePath.value = '/'
    await listRemoteDir('/')
  }

  async function disconnect(sessionId: string) {
    await sftpDisconnect(sessionId)
    sessions.value.delete(sessionId)
    remoteFiles.value = []
    remotePath.value = '/'
  }

  async function listLocalDir(path: string) {
    loading.value.local = true
    try {
      // TODO: Implement with Tauri fs API
      localPath.value = path
      localFiles.value = []
    } finally {
      loading.value.local = false
    }
  }

  async function listRemoteDir(path: string) {
    if (!currentSessionId.value) return
    loading.value.remote = true
    try {
      const files = await sftpListDir(currentSessionId.value, path)
      remoteFiles.value = files
      remotePath.value = path
    } finally {
      loading.value.remote = false
    }
  }

  async function createDirectory(path: string) {
    if (!currentSessionId.value) return
    await sftpMkdir(currentSessionId.value, path)
    await listRemoteDir(remotePath.value)
  }

  async function renameItem(from: string, to: string) {
    if (!currentSessionId.value) return
    await sftpRename(currentSessionId.value, from, to)
    await listRemoteDir(remotePath.value)
  }

  async function deleteItem(path: string, isDir: boolean) {
    if (!currentSessionId.value) return
    await sftpDelete(currentSessionId.value, path, isDir)
    await listRemoteDir(remotePath.value)
  }

  async function uploadFiles(localPaths: string[], remoteDir: string) {
    if (!currentSessionId.value) return
    const transferId = await sftpUpload(currentSessionId.value, localPaths, remoteDir)
    await refreshTransfers()
    return transferId
  }

  async function downloadFiles(remotePaths: string[], localDir: string) {
    if (!currentSessionId.value) return
    const transferId = await sftpDownload(currentSessionId.value, remotePaths, localDir)
    await refreshTransfers()
    return transferId
  }

  async function cancelTransfer(transferId: string) {
    await sftpCancelTransfer(transferId)
    await refreshTransfers()
  }

  async function refreshTransfers() {
    if (!currentSessionId.value) return
    transfers.value = await sftpListTransfers(currentSessionId.value)
  }

  async function changePermissions(path: string, permissions: number) {
    if (!currentSessionId.value) return
    await sftpSetPermissions(currentSessionId.value, path, permissions)
    await listRemoteDir(remotePath.value)
  }

  async function searchFiles(path: string, pattern: string) {
    if (!currentSessionId.value) return
    isSearching.value = true
    try {
      searchResults.value = await sftpSearch(currentSessionId.value, path, pattern)
    } finally {
      isSearching.value = false
    }
  }

  function clearSearch() {
    searchResults.value = []
    isSearching.value = false
  }

  return {
    // State
    sessions,
    localPath,
    remotePath,
    localFiles,
    remoteFiles,
    transfers,
    searchResults,
    isSearching,
    loading,
    // Computed
    currentSessionId,
    // Actions
    connect,
    disconnect,
    listLocalDir,
    listRemoteDir,
    createDirectory,
    renameItem,
    deleteItem,
    uploadFiles,
    downloadFiles,
    cancelTransfer,
    refreshTransfers,
    changePermissions,
    searchFiles,
    clearSearch
  }
})
