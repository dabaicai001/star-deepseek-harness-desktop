<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  path: string
  side: 'local' | 'remote'
}>()

const emit = defineEmits<{
  navigate: [path: string]
}>()

const segments = computed(() => {
  const parts = props.path.split('/').filter(Boolean)
  return parts.map((part, index) => ({
    name: part,
    path: '/' + parts.slice(0, index + 1).join('/')
  }))
})

function handleClick(targetPath: string) {
  emit('navigate', targetPath)
}

function handleRoot() {
  emit('navigate', '/')
}
</script>

<template>
  <div class="path-breadcrumb">
    <span class="crumb root" @click="handleRoot">/</span>
    <template v-for="(seg, i) in segments" :key="seg.path">
      <span class="separator">/</span>
      <span
        class="crumb"
        :class="{ active: i === segments.length - 1 }"
        @click="handleClick(seg.path)"
      >{{ seg.name }}</span>
    </template>
  </div>
</template>

<style scoped>
.path-breadcrumb {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 12px;
  background: rgba(20, 25, 40, 0.6);
  border-radius: 6px;
  overflow-x: auto;
  white-space: nowrap;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
}

.crumb {
  color: var(--muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  transition: all 0.15s;
}

.crumb:hover {
  color: var(--cyan);
  background: rgba(0, 240, 255, 0.08);
}

.crumb.active {
  color: var(--cyan);
}

.separator {
  color: var(--line-2);
  user-select: none;
}
</style>
