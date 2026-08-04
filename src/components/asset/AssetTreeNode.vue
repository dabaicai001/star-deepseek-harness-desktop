<script setup lang="ts">
/**
 * 资产树对象节点(递归):实例 → 分组 → 对象 的第 2/3 层。
 * 数据全部来自 objectTree store,本组件只负责渲染与事件上抛。
 */
import { computed } from 'vue'
import { useObjectTreeStore, TABLE_TRUNCATE, type ObjectNode } from '@/stores/objectTree'

const props = withDefaults(defineProps<{
  assetId: string
  node: ObjectNode
  depth: number
  /** 过滤态:忽略 store expanded,强制展示命中路径上的子级(不污染持久化展开态) */
  forceExpand?: boolean
  /** 连接内过滤词(非空时只渲染 label 命中或后代命中的已加载子节点) */
  filter?: string
}>(), { forceExpand: false, filter: '' })
const emit = defineEmits<{
  toggle: [node: ObjectNode]
  select: [node: ObjectNode]
  ctx: [payload: { node: ObjectNode; x: number; y: number }]
}>()

const tree = useObjectTreeStore()
const expanded = computed(() => props.forceExpand || tree.isExpanded(props.assetId, props.node.key))
const loading = computed(() => tree.stateOf(props.assetId)?.loadingKeys.includes(props.node.key) ?? false)
const error = computed(() => tree.stateOf(props.assetId)?.errorByKey[props.node.key] ?? null)
const children = computed(() => tree.childrenOf(props.assetId, props.node.key))
const pad = computed(() => `${18 + props.depth * 14}px`)
const childPad = computed(() => `${18 + (props.depth + 1) * 14}px`)
const isMore = computed(() => Boolean(props.node.payload?.more))

/** 层级引导线:每层祖先一条 1px 竖线(背景渐变实现),与 chevron 中心对齐,随缩进退位 */
const guides = computed(() => {
  const n = props.depth - 1
  if (n <= 0) return null
  return {
    backgroundImage: Array(n).fill('linear-gradient(var(--line-2), var(--line-2))').join(', '),
    backgroundSize: Array(n).fill('1px 100%').join(', '),
    backgroundRepeat: 'no-repeat',
    backgroundPosition: Array.from({ length: n }, (_, i) => `${18 + (i + 1) * 14 + 5}px 0`).join(', ')
  }
})

/** label 命中(大小写不敏感)或任一已加载后代命中;redis 叶子 label 是相对名,需用 payload.key 全键名匹配 */
function nodeMatches(n: ObjectNode, q: string): boolean {
  if (n.label.toLowerCase().includes(q)) return true
  const fullKey = String(n.payload?.key ?? '').toLowerCase()
  if (fullKey && fullKey.includes(q)) return true
  return tree.childrenOf(props.assetId, n.key).some(c => nodeMatches(c, q))
}

/** 表列表渲染截断:全量已在 store(过滤始终命中全部表);非过滤态默认只渲染前 TABLE_TRUNCATE 张 */
const truncatedCount = computed(() => {
  if (props.node.kind !== 'database') return 0
  if (props.filter.trim()) return 0
  if (tree.isTableListFull(props.assetId, props.node.key)) return 0
  const extra = children.value.length - TABLE_TRUNCATE
  return extra > 0 ? extra : 0
})

/** 过滤态下只渲染命中路径上的子级;否则渲染全部已加载子级(表列表按 TABLE_TRUNCATE 截断) */
const visibleChildren = computed(() => {
  const q = props.filter.trim().toLowerCase()
  if (!q) {
    return truncatedCount.value > 0 ? children.value.slice(0, TABLE_TRUNCATE) : children.value
  }
  return children.value.filter(c => nodeMatches(c, q))
})

function icon(n: ObjectNode): string {
  if (n.payload?.more) return 'mdi-dots-horizontal'
  switch (n.kind) {
    case 'database': return 'mdi-database-outline'
    case 'table': return 'mdi-table'
    case 'redis-db': return 'mdi-database'
    case 'redis-ns': return 'mdi-folder-outline'
    case 'redis-key': return 'mdi-key-variant'
    case 'es-group': return 'mdi-folder-multiple-outline'
    case 'es-index': return 'mdi-text-search'
    case 'kafka-topic': return 'mdi-view-list-outline'
    case 'nsq-topic': return 'mdi-view-list-outline'
    case 'nsq-channel': return 'mdi-arrow-right-bold-outline'
    default: return 'mdi-circle-small'
  }
}

function onLabelClick() {
  if (isMore.value) { emit('toggle', props.node); return }
  // 中间层只展开/收起;末层才选中(拉起工作区 tab)
  if (props.node.hasChildren) { emit('toggle', props.node); return }
  emit('select', props.node)
}

/** '+ N more' 行:纯渲染层截断,点击展示全部表(无异步、无连接依赖) */
function onShowAllTables() {
  tree.showAllTables(props.assetId, props.node.key)
}
</script>

<template>
  <div
    class="obj-node" :class="{ more: isMore }" :style="{ paddingLeft: pad, ...(guides ?? {}) }"
    @contextmenu.prevent.stop="!isMore && emit('ctx', { node, x: $event.clientX, y: $event.clientY })"
  >
    <v-icon
      v-if="node.hasChildren"
      class="obj-chevron" :class="{ open: expanded }"
      size="10"
      @click.stop="emit('toggle', node)"
    >mdi-chevron-right</v-icon>
    <span v-else class="obj-chevron-spacer" />
    <v-icon size="12" class="obj-icon">{{ icon(node) }}</v-icon>
    <span class="obj-label" @click="onLabelClick">{{ node.label }}</span>
    <span v-if="node.count !== undefined" class="obj-count">{{ node.count }}</span>
    <span v-else-if="node.meta" class="obj-meta">{{ node.meta }}</span>
  </div>
  <div v-if="loading" class="obj-hint" :style="{ paddingLeft: childPad }">加载中…</div>
  <div v-else-if="error" class="obj-hint obj-error" :style="{ paddingLeft: childPad }">
    加载失败 · <a href="javascript:void 0" @click="emit('toggle', node)">重试</a>
  </div>
  <template v-if="expanded && !loading">
    <AssetTreeNode
      v-for="child in visibleChildren" :key="child.key"
      :asset-id="assetId" :node="child" :depth="depth + 1"
      :force-expand="forceExpand" :filter="filter"
      @toggle="emit('toggle', $event)" @select="emit('select', $event)" @ctx="emit('ctx', $event)"
    />
    <div
      v-if="truncatedCount > 0"
      class="obj-node more" :style="{ paddingLeft: childPad }"
      @click="onShowAllTables"
    >
      <span class="obj-chevron-spacer" />
      <v-icon size="12" class="obj-icon">mdi-dots-horizontal</v-icon>
      <span class="obj-label">+ {{ truncatedCount }} more</span>
    </div>
  </template>
</template>

<style scoped>
.obj-node { display: flex; align-items: center; gap: 5px; padding-top: 3px; padding-bottom: 3px; padding-right: 10px; font-size: 11px; color: var(--text-2); cursor: pointer; user-select: none; }
.obj-node:hover { background: var(--hover-cyan-faint, rgba(127, 127, 127, 0.08)); color: var(--text); }
.obj-node.more { color: var(--muted); font-style: italic; }
.obj-chevron { color: var(--muted); transition: transform 0.15s; flex-shrink: 0; width: 10px; }
.obj-chevron.open { transform: rotate(90deg); }
.obj-chevron-spacer { width: 10px; flex-shrink: 0; }
.obj-icon { color: var(--muted); flex-shrink: 0; }
.obj-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'JetBrains Mono', monospace; }
.obj-count, .obj-meta { font-size: 9px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
.obj-hint { padding-top: 2px; padding-bottom: 2px; font-size: 10px; color: var(--muted); }
.obj-error a { color: var(--cyan); }
</style>
