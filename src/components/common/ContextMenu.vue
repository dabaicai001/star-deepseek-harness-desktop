<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'

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
const selectedIdx = ref(-1)

const enabledItemIndexes = computed(() =>
  props.items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.type !== 'divider' && item.type !== 'header' && !item.disabled)
    .map(({ idx }) => idx)
)

function close() {
  emit('close')
}

function handleItemClick(item: MenuItem) {
  if (item.disabled || item.type === 'divider' || item.type === 'header') return
  if (item.onClick) item.onClick()
  close()
}

function moveSelection(delta: number) {
  const indexes = enabledItemIndexes.value
  if (indexes.length === 0) return
  const currentPos = indexes.indexOf(selectedIdx.value)
  const nextPos = currentPos === -1
    ? (delta > 0 ? 0 : indexes.length - 1)
    : (currentPos + delta + indexes.length) % indexes.length
  selectedIdx.value = indexes[nextPos]
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
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
  } else if (e.key === 'Home') {
    e.preventDefault()
    selectedIdx.value = enabledItemIndexes.value[0] ?? -1
  } else if (e.key === 'End') {
    e.preventDefault()
    const indexes = enabledItemIndexes.value
    selectedIdx.value = indexes[indexes.length - 1] ?? -1
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (selectedIdx.value < 0) return
    e.preventDefault()
    handleItemClick(props.items[selectedIdx.value])
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
    menuRef.value.focus()
    selectedIdx.value = enabledItemIndexes.value[0] ?? -1
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
      tabindex="-1"
      role="menu"
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
          :class="{ disabled: item.disabled, danger: item.danger, selected: idx === selectedIdx }"
          role="menuitem"
          :aria-disabled="item.disabled ? 'true' : 'false'"
          @click="handleItemClick(item)"
          @mouseenter="selectedIdx = item.disabled ? selectedIdx : idx"
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
