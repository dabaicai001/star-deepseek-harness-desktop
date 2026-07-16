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
  /** 预留子菜单能力；当前 UI 尚未渲染 children */
  children?: MenuItem[]
  onClick?: () => void
}

const props = withDefaults(defineProps<{
  x: number
  y: number
  items: MenuItem[]
  /** 空间不足时是否向上/向左翻转，默认 true */
  flip?: boolean
}>(), {
  flip: true
})

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
  scrollSelectedIntoView()
}

function scrollSelectedIntoView() {
  nextTick(() => {
    if (!menuRef.value || selectedIdx.value < 0) return
    const el = menuRef.value.querySelector(`[data-cm-index="${selectedIdx.value}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  })
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
    const indexes = enabledItemIndexes.value
    selectedIdx.value = indexes[0] ?? -1
    scrollSelectedIntoView()
  } else if (e.key === 'End') {
    e.preventDefault()
    const indexes = enabledItemIndexes.value
    selectedIdx.value = indexes[indexes.length - 1] ?? -1
    scrollSelectedIntoView()
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (selectedIdx.value < 0) return
    e.preventDefault()
    handleItemClick(props.items[selectedIdx.value])
  } else if (e.key === 'Tab') {
    // Focus trap：Tab 在菜单项之间循环，不跳到页面其他元素
    e.preventDefault()
    moveSelection(e.shiftKey ? -1 : 1)
  }
}

function onWindowResize() {
  close()
}

function onWindowScroll() {
  close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointer, true)
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('scroll', onWindowScroll, true)
  window.addEventListener('blur', close)

  void nextTick().then(() => {
    if (!menuRef.value) return
    menuRef.value.focus()
    const rect = menuRef.value.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const pad = 8
    let nx = props.x
    let ny = props.y

    // 水平边界
    if (nx + rect.width > vw - pad) nx = vw - rect.width - pad
    if (nx < pad) nx = pad

    // 垂直边界：下方空间不足则向上翻转
    if (props.flip && ny + rect.height > vh - pad) {
      ny = props.y - rect.height
    }
    if (ny + rect.height > vh - pad) ny = vh - rect.height - pad
    if (ny < pad) ny = pad

    adjusted.value = { x: nx, y: ny }
    selectedIdx.value = enabledItemIndexes.value[0] ?? -1
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('scroll', onWindowScroll, true)
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
      aria-modal="true"
      @contextmenu.prevent
    >
      <template v-for="(item, idx) in items" :key="idx">
        <div
          v-if="item.type === 'divider'"
          class="cm-divider"
          :data-cm-index="idx"
        />
        <div
          v-else-if="item.type === 'header'"
          class="cm-header"
          :data-cm-index="idx"
        >
          <v-icon v-if="item.icon" class="type-icon" size="12">{{ item.icon }}</v-icon>
          <span>{{ item.label }}</span>
        </div>
        <div
          v-else
          class="cm-item"
          :class="{ disabled: item.disabled, danger: item.danger, selected: idx === selectedIdx }"
          :data-cm-index="idx"
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
