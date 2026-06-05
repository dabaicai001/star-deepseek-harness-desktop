<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { FileEntry } from '../../services/sftp'
import { formatFileSize, formatPermissions } from '../../services/sftp'

const props = defineProps<{
  entry: FileEntry
  sessionId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const content = ref<string | null>(null)
const loading = ref(false)

const isTextFile = computed(() => {
  const textExts = ['.txt', '.md', '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf',
    '.log', '.sh', '.bash', '.py', '.js', '.ts', '.go', '.rs', '.java', '.c', '.cpp', '.h',
    '.css', '.html', '.sql', '.csv', '.env', '.gitignore', '.dockerfile']
  const lower = props.entry.name.toLowerCase()
  return textExts.some(ext => lower.endsWith(ext)) || props.entry.size < 2 * 1024 * 1024
})

const isImage = computed(() => {
  const imgExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']
  const lower = props.entry.name.toLowerCase()
  return imgExts.some(ext => lower.endsWith(ext))
})

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

onMounted(async () => {
  if (isTextFile.value && props.entry.size < 2 * 1024 * 1024) {
    loading.value = true
    try {
      // TODO: Implement file content fetch via Tauri invoke
      content.value = '[Preview not yet implemented]'
    } finally {
      loading.value = false
    }
  }
})
</script>

<template>
  <div class="file-preview cyber-panel">
    <div class="modal-header">
      <div class="icon-box">
        <span class="mdi">mdi-file-eye</span>
      </div>
      <h3>{{ entry.name }}</h3>
      <button class="action-btn" @click="emit('close')">
        <span class="mdi">mdi-close</span>
      </button>
    </div>

    <div class="preview-meta">
      <div class="meta-row">
        <span class="meta-label">Size</span>
        <span class="meta-value mono">{{ formatFileSize(entry.size) }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Permissions</span>
        <span class="meta-value mono">{{ formatPermissions(entry.permissions) }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Modified</span>
        <span class="meta-value mono">{{ formatDate(entry.modified) }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Path</span>
        <span class="meta-value mono">{{ entry.path }}</span>
      </div>
    </div>

    <div class="preview-content">
      <div v-if="loading" class="preview-loading">
        <div class="loading-spinner"></div>
        <span>Loading content...</span>
      </div>

      <pre v-else-if="isTextFile && content !== null" class="preview-text">{{ content }}</pre>

      <div v-else-if="isImage" class="preview-image">
        <span class="mdi" style="font-size: 48px; color: var(--muted)">mdi-image</span>
        <span class="image-hint">Image preview not available</span>
      </div>

      <div v-else class="empty-state">
        <div class="empty-state-icon">📄</div>
        <div class="empty-state-title">Preview not available</div>
        <div class="empty-state-desc">This file type cannot be previewed</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-preview {
  display: flex;
  flex-direction: column;
  max-height: 80vh;
}

.preview-meta {
  padding: 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-bottom: 1px solid var(--line);
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}

.meta-label {
  color: var(--muted);
  min-width: 80px;
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.06em;
}

.meta-value {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-value.mono {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.preview-content {
  flex: 1;
  overflow: auto;
  padding: 16px 20px;
  min-height: 120px;
}

.preview-text {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}

.preview-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 48px;
  color: var(--muted);
}

.loading-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--line-2);
  border-top-color: var(--cyan);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.preview-image {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px;
}

.image-hint {
  font-size: 12px;
  color: var(--muted);
}
</style>
