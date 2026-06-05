<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'

export interface MenuItem {
  type?: 'item' | 'divider' | 'header'
  label?: string
  icon?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  onClick?: () => void
}

const props = defineProps<{
  x: number
  y: number
  items: MenuItem[]
}>()

const emit = defineEmits<{
  close: []
}>()

const menuRef = ref<HTMLDivElement>()
const adjusted = ref({ x: props.x, y: props.y })

function close() {
  emit('close')
}

function handleItemClick(item: MenuItem) {
  if (item.disabled || item.type !== 'item') return
  if (item.onClick) item.onClick()
  close()
}

function onDocPointer(e: PointerEvent) {
  if (!menuRef.value) return
  if (!menuRef.value.contains(e.target as Node)) {
    close()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

function onWindowResize() {
  close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer, true)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('blur', close)

  // 防止默认右键菜单
  void nextTick().then(() => {
    if (!menuRef.value) return
    const rect = menuRef.value.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let nx = props.x
    let ny = props.y
    if (nx + rect.width > vw - 8) nx = vw - rect.width - 8
    if (ny + rect.height > vh - 8) ny = vh - rect.height - 8
    if (nx < 8) nx = 8
    if (ny < 8) ny = 8
    adjusted.value = { x: nx, y: ny }
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('blur', close)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="context-menu"
      :style="{ left: adjusted.x + 'px', top: adjusted.y + 'px' }"
      @contextmenu.prevent
    >
      <template v-for="(item, idx) in items" :key="idx">
        <div
          v-if="item.type === 'divider'"
          class="cm-divider"
        />
        <div
          v-else-if="item.type === 'header'"
          class="cm-header"
        >
          <v-icon v-if="item.icon" class="type-icon" size="12">{{ item.icon }}</v-icon>
          <span>{{ item.label }}</span>
        </div>
        <div
          v-else
          class="cm-item"
          :class="{ disabled: item.disabled, danger: item.danger }"
          @click="handleItemClick(item)"
        >
          <v-icon v-if="item.checked" class="check">mdi-check</v-icon>
          <v-icon v-else-if="item.icon" class="mdi">{{ item.icon }}</v-icon>
          <span class="label">{{ item.label }}</span>
          <span v-if="item.shortcut" class="shortcut">{{ item.shortcut }}</span>
        </div>
      </template>
    </div>
  </Teleport>
</template>
