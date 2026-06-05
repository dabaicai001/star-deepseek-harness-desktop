<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { FileEntry } from '../../services/sftp'
import { useSftpStore } from '../../stores/sftp'
import FilePanel from './FilePanel.vue'
import TransferQueue from './TransferQueue.vue'
import ContextMenu from './ContextMenu.vue'
import SearchBar from './SearchBar.vue'
import FilePreview from './FilePreview.vue'
import ChmodDialog from './ChmodDialog.vue'

const props = defineProps<{
  sessionId: string
}>()

const store = useSftpStore()

const contextMenu = ref({ visible: false, x: 0, y: 0, entry: null as FileEntry | null })
const previewEntry = ref<FileEntry | null>(null)
const chmodDialog = ref({ visible: false, permissions: 0, fileName: '', filePath: '' })
const searchVisible = ref(false)
const searchSide = ref<'local' | 'remote'>('remote')

onMounted(() => {
  store.connect(props.sessionId)
})

function handleNavigate(side: 'local' | 'remote', path: string) {
  if (side === 'local') {
    store.listLocalDir(path)
  } else {
    store.listRemoteDir(path)
  }
}

function handleOpen(side: 'local' | 'remote', entry: FileEntry) {
  if (entry.is_dir) {
    handleNavigate(side, entry.path)
  } else {
    previewEntry.value = entry
  }
}

function handleContextMenu(e: MouseEvent, side: 'local' | 'remote', entry: FileEntry | null) {
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY, entry }
}

function closeContextMenu() {
  contextMenu.value = { ...contextMenu.value, visible: false }
}

function handleNewFolder() {
  closeContextMenu()
  const name = prompt('Folder name:')
  if (name) {
    const basePath = store.remotePath
    store.createDirectory(`${basePath}/${name}`.replace(/\/+/g, '/'))
  }
}

function handleDelete() {
  closeContextMenu()
  const entry = contextMenu.value.entry
  if (!entry) return
  if (confirm(`Delete "${entry.name}"?`)) {
    store.deleteItem(entry.path, entry.is_dir)
  }
}

function handleRename() {
  closeContextMenu()
  const entry = contextMenu.value.entry
  if (!entry) return
  const newName = prompt('New name:', entry.name)
  if (newName && newName !== entry.name) {
    const dir = entry.path.substring(0, entry.path.lastIndexOf('/'))
    store.renameItem(entry.path, `${dir}/${newName}`.replace(/\/+/g, '/'))
  }
}

function handlePermissions() {
  closeContextMenu()
  const entry = contextMenu.value.entry
  if (!entry) return
  chmodDialog.value = {
    visible: true,
    permissions: entry.permissions,
    fileName: entry.name,
    filePath: entry.path
  }
}

function handleChmodConfirm(permissions: number) {
  store.changePermissions(chmodDialog.value.filePath, permissions)
  chmodDialog.value = { ...chmodDialog.value, visible: false }
}

function handlePreview() {
  closeContextMenu()
  const entry = contextMenu.value.entry
  if (entry) {
    previewEntry.value = entry
  }
}

function handleUpload(localPaths: string[]) {
  store.uploadFiles(localPaths, store.remotePath)
}

function handleDownload(remotePaths: string[]) {
  store.downloadFiles(remotePaths, store.localPath)
}

function handleSearch(pattern: string) {
  store.searchFiles(store.remotePath, pattern)
  searchVisible.value = false
}
</script>

<template>
  <div class="sftp-dual-panel">
    <div v-if="searchVisible" class="search-row">
      <SearchBar
        @search="handleSearch"
        @close="searchVisible = false"
      />
    </div>

    <div class="panels-container">
      <FilePanel
        side="local"
        :path="store.localPath"
        :files="store.localFiles"
        :loading="store.loading.local"
        @navigate="(p) => handleNavigate('local', p)"
        @open="(e) => handleOpen('local', e)"
        @upload="handleUpload"
        @download="handleDownload"
        @contextmenu="(ev, e) => handleContextMenu(ev, 'local', e)"
      />

      <div class="panel-divider"></div>

      <FilePanel
        side="remote"
        :path="store.remotePath"
        :files="store.remoteFiles"
        :loading="store.loading.remote"
        @navigate="(p) => handleNavigate('remote', p)"
        @open="(e) => handleOpen('remote', e)"
        @upload="handleUpload"
        @download="handleDownload"
        @contextmenu="(ev, e) => handleContextMenu(ev, 'remote', e)"
      />
    </div>

    <TransferQueue
      :transfers="store.transfers"
      @cancel="store.cancelTransfer"
    />

    <ContextMenu
      :visible="contextMenu.visible"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :entry="contextMenu.entry"
      @new-folder="handleNewFolder"
      @delete="handleDelete"
      @rename="handleRename"
      @permissions="handlePermissions"
      @preview="handlePreview"
      @close="closeContextMenu"
    />

    <FilePreview
      v-if="previewEntry"
      :entry="previewEntry"
      :session-id="props.sessionId"
      @close="previewEntry = null"
    />

    <ChmodDialog
      :visible="chmodDialog.visible"
      :current-permissions="chmodDialog.permissions"
      :file-name="chmodDialog.fileName"
      @confirm="handleChmodConfirm"
      @cancel="chmodDialog.visible = false"
    />
  </div>
</template>

<style scoped>
.sftp-dual-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 8px;
  padding: 8px;
}

.search-row {
  flex-shrink: 0;
}

.panels-container {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 8px;
}

.panel-divider {
  width: 1px;
  background: var(--line-2);
  flex-shrink: 0;
}
</style>
