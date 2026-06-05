<script setup lang="ts">
import { watch, onMounted, onBeforeUnmount } from 'vue'
import type { FileEntry } from '../../services/sftp'

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  entry: FileEntry | null
}>()

const emit = defineEmits<{
  newFolder: []
  delete: []
  rename: []
  permissions: []
  preview: []
  close: []
}>()

function handleClickOutside() {
  if (props.visible) {
    emit('close')
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.visible) {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="context-menu"
      :style="{ left: `${x}px`, top: `${y}px` }"
      @click.stop
    >
      <template v-if="entry">
        <div class="cm-header">
          <span class="type-icon">{{ entry.is_dir ? '📁' : '📄' }}</span>
          <span>{{ entry.name }}</span>
        </div>
        <div class="cm-divider"></div>
      </template>

      <div class="cm-item" @click="emit('newFolder')">
        <span class="mdi">mdi-folder-plus</span>
        <span class="label">New Folder</span>
      </div>

      <template v-if="entry">
        <div class="cm-item" @click="emit('rename')">
          <span class="mdi">mdi-pencil</span>
          <span class="label">Rename</span>
        </div>

        <div v-if="!entry.is_dir" class="cm-item" @click="emit('preview')">
          <span class="mdi">mdi-eye</span>
          <span class="label">Preview</span>
        </div>

        <div class="cm-item" @click="emit('permissions')">
          <span class="mdi">mdi-shield-key</span>
          <span class="label">Permissions</span>
        </div>

        <div class="cm-divider"></div>

        <div class="cm-item danger" @click="emit('delete')">
          <span class="mdi">mdi-delete</span>
          <span class="label">Delete</span>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 200px;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 10px;
  padding: 4px;
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(0, 240, 255, 0.06);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: cm-appear 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: top left;
  user-select: none;
}

@keyframes cm-appear {
  from { opacity: 0; transform: scale(0.96) translateY(-4px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}

.cm-header {
  font-size: 10px;
  color: var(--muted);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 8px 12px 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.cm-header .type-icon {
  color: var(--cyan);
  font-size: 12px;
}

.cm-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 8px;
}

.cm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  font-size: 12.5px;
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.12s;
}

.cm-item .mdi {
  font-size: 14px;
  color: var(--muted);
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}

.cm-item .label {
  flex: 1;
  white-space: nowrap;
}

.cm-item:hover:not(.disabled) {
  background: rgba(0, 240, 255, 0.08);
  color: var(--text);
}

.cm-item:hover:not(.disabled) .mdi {
  color: var(--cyan);
}

.cm-item.danger {
  color: var(--red);
}

.cm-item.danger .mdi {
  color: var(--red);
  opacity: 0.7;
}

.cm-item.danger:hover:not(.disabled) {
  background: rgba(255, 77, 109, 0.1);
  color: var(--red);
}

.cm-item.danger:hover:not(.disabled) .mdi {
  color: var(--red);
  opacity: 1;
}
</style>
