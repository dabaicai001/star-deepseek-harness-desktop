<script setup lang="ts">
import { ref, computed, markRaw, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialogStore } from '@/stores/dialog'
import StringEditor from './editors/StringEditor.vue'
import HashEditor from './editors/HashEditor.vue'
import ListEditor from './editors/ListEditor.vue'
import SetEditor from './editors/SetEditor.vue'
import ZSetEditor from './editors/ZSetEditor.vue'

const props = defineProps<{ connId: string; currentDb: number }>()

const dlg = useDialogStore()
const { t } = useI18n()

interface EditorTab {
  id: string; key: string; type: string; title: string; db: number; revision: number
  isDirty: boolean; isNew: boolean; component: Component
}

const tabs = ref<EditorTab[]>([])
const activeTabId = ref<string | null>(null)

const editorMap: Record<string, Component> = {
  string: markRaw(StringEditor), hash: markRaw(HashEditor),
  list: markRaw(ListEditor), set: markRaw(SetEditor), zset: markRaw(ZSetEditor),
  stream: markRaw(StringEditor),
}

function typeColor(t: string) { const m: Record<string, string> = { string: 'var(--green)', hash: 'var(--purple)', list: 'var(--cyan)', set: 'var(--yellow)', zset: 'var(--pink)', stream: 'var(--cyan)' }; return m[t] || 'var(--muted)' }
function typeIcon(t: string) { const m: Record<string, string> = { string: 'mdi-format-text', hash: 'mdi-pound', list: 'mdi-format-list-bulleted', set: 'mdi-set-center', zset: 'mdi-sort-numeric-ascending', stream: 'mdi-chart-timeline-variant' }; return m[t] || 'mdi-key' }

function openKey(key: string, type: string) {
  const existing = tabs.value.find(t => t.key === key && t.db === props.currentDb)
  if (existing) {
    if (!existing.isDirty) existing.revision++
    activeTabId.value = existing.id
    return
  }
  const id = `key-db${props.currentDb}-${key}-${Date.now()}`
  const editor = editorMap[type] || editorMap.string
  tabs.value.push({ id, key, type, title: key, db: props.currentDb, revision: 0, isDirty: false, isNew: false, component: editor })
  activeTabId.value = id
}

async function closeTab(id: string) {
  const idx = tabs.value.findIndex(t => t.id === id)
  if (idx === -1) return
  if (tabs.value[idx].isDirty) {
    const ok = await dlg.confirm({
      message: t('redis.unsavedChanges', { key: tabs.value[idx].key }),
      confirmText: t('common.confirm'),
    })
    if (!ok) return
  }
  tabs.value.splice(idx, 1)
  if (activeTabId.value === id) activeTabId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? null
}

async function openNewKey() {
  const key = await dlg.prompt({
    message: t('redis.newKeyNamePrompt'),
    placeholder: t('redis.keyNameExample'),
    requireNonEmpty: true,
  })
  if (!key) return
  const type = await dlg.prompt({
    message: t('redis.keyTypePrompt'),
    selectOptions: ['string', 'hash', 'list', 'set', 'zset'],
    selectDefault: 'string',
  }) || 'string'
  if (!editorMap[type]) return
  const id = `new-${key}-${Date.now()}`
  tabs.value.push({ id, key, type, title: key, db: props.currentDb, revision: 0, isDirty: true, isNew: true, component: editorMap[type] })
  activeTabId.value = id
}

const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value) || null)
function updateDirty(v: boolean) { if (activeTab.value) activeTab.value.isDirty = v }
function markSaved() { if (activeTab.value) { activeTab.value.isDirty = false; activeTab.value.isNew = false } }

watch(() => props.currentDb, () => {
  tabs.value = []
  activeTabId.value = null
})

defineExpose({ openKey })
</script>

<template>
  <div class="value-editor">
    <div class="editor-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="cyber-tab"
        :class="{ active: tab.id === activeTabId }"
        @click="activeTabId = tab.id"
      >
        <v-icon size="12" :style="{ color: typeColor(tab.type) }">{{ typeIcon(tab.type) }}</v-icon>
        <span class="tab-title">{{ tab.key }}</span>
        <span v-if="tab.isDirty" class="dirty-dot">&#9679;</span>
        <button class="tab-close" @click.stop="closeTab(tab.id)"><v-icon size="10">mdi-close</v-icon></button>
      </button>
      <button class="cyber-tab tab-add" @click="openNewKey"><v-icon size="14">mdi-plus</v-icon></button>
    </div>
    <div class="editor-body" v-if="activeTab">
      <component
        :is="activeTab.component"
        :key="`${activeTab.id}:${activeTab.revision}`"
        :conn-id="connId"
        :key-name="activeTab.key"
        :key-type="activeTab.type"
        :is-new="activeTab.isNew"
        @dirty="updateDirty"
        @saved="markSaved"
      />
    </div>
    <div v-else class="empty-state">
      <v-icon size="48" style="color: var(--muted)">mdi-key-variant</v-icon>
      <span class="empty-state-title">{{ t('redis.noKeySelected') }}</span>
      <span class="empty-state-desc">{{ t('redis.noKeySelectedDesc') }}</span>
    </div>
  </div>
</template>

<style scoped>
.value-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.editor-tabs { display: flex; align-items: center; padding: 0 8px; border-bottom: 1px solid var(--line); flex-shrink: 0; overflow-x: auto; }
.tab-title { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close { width: 16px; height: 16px; border-radius: 3px; border: none; background: transparent; color: var(--muted); cursor: pointer; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s; }
.cyber-tab:hover .tab-close { opacity: 1; }
.tab-close:hover { color: var(--red); background: rgba(255, 77, 109, 0.1); }
.tab-add { border: 1px dashed var(--line-2) !important; }
.tab-add:hover { border-color: var(--cyan) !important; color: var(--cyan) !important; }
.dirty-dot { color: var(--yellow); font-size: 8px; line-height: 1; }
.editor-body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.empty-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.empty-state-title { font-size: 14px; color: var(--text-2); }
.empty-state-desc { font-size: 12px; color: var(--muted); }
</style>
