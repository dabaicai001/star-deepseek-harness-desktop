<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  search: [pattern: string]
  close: []
}>()

const pattern = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

function handleSearch() {
  if (pattern.value.trim()) {
    emit('search', pattern.value.trim())
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
  } else if (e.key === 'Enter') {
    handleSearch()
  }
}

function handleClear() {
  pattern.value = ''
  inputRef.value?.focus()
}
</script>

<template>
  <div class="search-bar">
    <span class="mdi">mdi-magnify</span>
    <input
      ref="inputRef"
      v-model="pattern"
      type="text"
      placeholder="Search files..."
      class="search-input"
      autofocus
      @keydown="handleKeydown"
    />
    <button v-if="pattern" class="action-btn" @click="handleClear" title="Clear">
      <span class="mdi">mdi-close</span>
    </button>
    <button class="action-btn" @click="handleSearch" title="Search">
      <span class="mdi">mdi-arrow-right</span>
    </button>
    <button class="action-btn" @click="emit('close')" title="Close">
      <span class="mdi">mdi-close-circle</span>
    </button>
  </div>
</template>

<style scoped>
.search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(20, 25, 40, 0.6);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  transition: all 0.2s;
}

.search-bar:focus-within {
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px rgba(0, 240, 255, 0.1);
}

.search-bar .mdi {
  color: var(--muted);
  font-size: 14px;
}

.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}

.search-input::placeholder {
  color: var(--muted);
}

.action-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn:hover {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.08);
}
</style>
