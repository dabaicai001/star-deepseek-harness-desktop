<script setup lang="ts">
/**
 * AiDshChat —— dsh 宿主聊天面板(替代 AiChat.vue)。
 *
 * 渲染 DshSessionProjection 的投影块(user / assistant / tool / todo / notice / subagent / error),
 * 提供输入区、停止/新会话、历史存档弹窗(右键:重命名/删除/复制标题)、消息右键复制,
 * 以及底部确认 dock(pendingApproval:审批门 / hostkey 确认,仅「拒绝/批准」两个按钮,无白名单)。
 *
 * 状态与操作全部由宿主(useAiDshHost)注入;本组件不直接依赖 aiStore。
 * 面向用户文案沿用项目 AI 面板的中文硬编码惯例。
 */
import { computed, nextTick, ref, watch } from 'vue'
import AiMessageContent from '@/components/ai/AiMessageContent.vue'
import ContextMenu, { type MenuItem } from '@/components/common/ContextMenu.vue'
import { aiConvList, aiConvMessages, aiConvRename, aiConvDelete, type AiConversationRow, type AiMessageRow } from '@/services/aiMemory'
import type { ProjectionBlock, DshTodoItem, DshTokenUsage } from '@/services/aiHarnessProjection'
import type { DshPendingApproval } from '@/composables/useAiDshHost'
import { useNotifyStore } from '@/stores/notify'

const props = withDefaults(defineProps<{
  blocks: readonly ProjectionBlock[]
  sending: boolean
  pendingApproval: DshPendingApproval | null
  lastUsage: DshTokenUsage | null
  sendError: string | null
  /** 空态引导 chips(由宿主视图传入各自的引导语) */
  suggestions?: string[]
  placeholder?: string
  /** 宿主提供后,assistant 回复里的代码块显示「执行」按钮(如 SSH 终端快捷执行) */
  runCommand?: (command: string) => void
}>(), {
  suggestions: () => [],
  placeholder: '问我关于这个连接的任何事…'
})

const emit = defineEmits<{
  send: [text: string]
  stop: []
  newChat: []
  resolveApproval: [approved: boolean]
}>()

const notifyStore = useNotifyStore()

const inputText = ref('')
const messagesRef = ref<HTMLElement | null>(null)

/** 工具卡展开状态(按 tool 块 id),长结果默认收起 */
const expandedTools = ref<Set<string>>(new Set())

function isToolExpanded(id: string): boolean {
  return expandedTools.value.has(id)
}

function toggleTool(id: string) {
  const next = new Set(expandedTools.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedTools.value = next
}

function shortText(value: string, max = 600): string {
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max)}\n… (+${value.length - max} chars)` : value
}

/** 助手气泡正文:reasoning 拼成 <think> 前缀,复用 AiMessageContent 的思考折叠渲染 */
function assistantContent(block: Extract<ProjectionBlock, { kind: 'assistant' }>): string {
  return block.reasoning ? `<think>${block.reasoning}</think>\n${block.text}` : block.text
}

function noticeText(notice: Extract<ProjectionBlock, { kind: 'notice' }>['notice']): string {
  if (notice === 'aborted') return '本轮已中止'
  if (notice === 'interrupted') return '已中断'
  if (notice === 'max-tokens') return '已达到上下文上限,请开始新会话'
  return '运行时已重启,会话已重置'
}

function todoIcon(status: DshTodoItem['status']): string {
  if (status === 'completed') return 'mdi-check-circle-outline'
  if (status === 'in_progress') return 'mdi-loading mdi-spin'
  return 'mdi-circle-outline'
}

// ====== 滚动 ======
watch(
  () => `${props.blocks.length}:${props.sending}:${props.sendError}`,
  () => scrollToBottom(),
  { flush: 'post' }
)
watch(() => props.blocks.length, () => scrollToBottom(), { flush: 'post' })

function scrollToBottom(force = false) {
  const container = messagesRef.value
  const wasNearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight <= 48
  nextTick(() => {
    if (messagesRef.value && (force || wasNearBottom)) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
  })
}

function onSend() {
  const text = inputText.value.trim()
  if (!text || props.sending) return
  inputText.value = ''
  emit('send', text)
}

/** 空态引导 chips:点击直接发送(不经输入框) */
function onSendText(text: string) {
  if (props.sending) return
  emit('send', text)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    onSend()
  }
}

// ====== 确认 dock ======
function approve() {
  emit('resolveApproval', true)
}

function reject() {
  emit('resolveApproval', false)
}

// ====== 右键菜单(消息气泡复制 + 历史行操作) ======
const menuVisible = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuItems = ref<MenuItem[]>([])

function openMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault()
  menuX.value = e.clientX
  menuY.value = e.clientY
  menuItems.value = items
  menuVisible.value = true
}

function closeMenu() {
  menuVisible.value = false
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notifyStore.notify({ message: '已复制', color: 'success', timeout: 1500 })
  } catch {
    notifyStore.notify({ message: '复制失败', color: 'warning', timeout: 2000 })
  }
}

function onBlockContextMenu(e: MouseEvent, text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  openMenu(e, [
    { label: '复制消息文本', icon: 'mdi-content-copy', onClick: () => void copyText(trimmed) }
  ])
}

// ====== 历史会话存档弹窗 ======
const historyVisible = ref(false)
const historyLoading = ref(false)
const historyRows = ref<AiConversationRow[]>([])
const historyError = ref('')
/** 正在查看的会话(非空 = 消息只读视图) */
const viewingConv = ref<AiConversationRow | null>(null)
const viewingMessages = ref<AiMessageRow[]>([])
const viewingLoading = ref(false)
/** 正在重命名的会话 */
const renameTarget = ref<AiConversationRow | null>(null)
const renameValue = ref('')

const isDesktopRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

async function openHistory() {
  historyVisible.value = true
  viewingConv.value = null
  viewingMessages.value = []
  renameTarget.value = null
  historyError.value = ''
  if (!isDesktopRuntime) return
  historyLoading.value = true
  try {
    historyRows.value = await aiConvList()
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : String(error)
    historyRows.value = []
  } finally {
    historyLoading.value = false
  }
}

function formatRelativeTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const diffMs = Date.now() - seconds * 1000
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  const date = new Date(seconds * 1000)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

async function viewConversation(row: AiConversationRow) {
  if (!isDesktopRuntime) return
  viewingConv.value = row
  viewingMessages.value = []
  viewingLoading.value = true
  try {
    viewingMessages.value = await aiConvMessages(row.id)
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : String(error)
  } finally {
    viewingLoading.value = false
  }
}

function backToList() {
  viewingConv.value = null
  viewingMessages.value = []
}

function onHistoryRowContextMenu(e: MouseEvent, row: AiConversationRow) {
  openMenu(e, [
    { label: '查看消息', icon: 'mdi-message-text-outline', onClick: () => void viewConversation(row) },
    { label: '复制标题', icon: 'mdi-content-copy', onClick: () => void copyText(row.title || '新会话') },
    { type: 'divider' },
    { label: '重命名', icon: 'mdi-pencil-outline', onClick: () => startRename(row) },
    { label: '删除', icon: 'mdi-delete-outline', danger: true, onClick: () => void deleteHistory(row) }
  ])
}

function startRename(row: AiConversationRow) {
  renameTarget.value = row
  renameValue.value = row.title || ''
}

async function confirmRename() {
  const target = renameTarget.value
  if (!target) return
  const title = renameValue.value.trim()
  renameTarget.value = null
  if (!title || title === (target.title || '')) return
  try {
    await aiConvRename(target.id, title)
    const row = historyRows.value.find(item => item.id === target.id)
    if (row) row.title = title
    notifyStore.notify({ message: '已重命名', color: 'success', timeout: 1500 })
  } catch (error) {
    notifyStore.notify({ message: `重命名失败:${error instanceof Error ? error.message : String(error)}`, color: 'warning', timeout: 2500 })
  }
}

async function deleteHistory(row: AiConversationRow) {
  try {
    await aiConvDelete(row.id)
    historyRows.value = historyRows.value.filter(item => item.id !== row.id)
    notifyStore.notify({ message: '已删除会话存档', color: 'success', timeout: 1500 })
  } catch (error) {
    notifyStore.notify({ message: `删除失败:${error instanceof Error ? error.message : String(error)}`, color: 'warning', timeout: 2500 })
  }
}

/** 存档消息只读展示:content 截断 + 工具标记 */
function messagePreview(row: AiMessageRow): string {
  const content = (row.content ?? '').trim()
  if (content.length <= 500) return content || '(空)'
  return `${content.slice(0, 500)}… (+${content.length - 500} 字符)`
}

function roleLabel(role: string): string {
  if (role === 'user') return '你'
  if (role === 'tool') return '工具'
  return 'AI'
}

const usageText = computed(() => {
  const usage = props.lastUsage
  if (!usage) return ''
  const parts = [`in ${usage.inputTokens}`, `out ${usage.outputTokens}`]
  if (usage.reasoningTokens) parts.push(`reasoning ${usage.reasoningTokens}`)
  return parts.join(' · ')
})

const emptyVisible = computed(() => props.blocks.length === 0)
</script>

<template>
  <div class="ai-dsh-chat">
    <!-- 顶部工具栏 -->
    <div class="chat-toolbar">
      <button class="toolbar-btn" title="新会话" @click="emit('newChat')">
        <v-icon size="14">mdi-plus</v-icon>
        <span>新会话</span>
      </button>
      <button class="action-btn" data-tooltip="历史会话" aria-label="历史会话" @click="openHistory">
        <v-icon size="14">mdi-history</v-icon>
      </button>
      <div class="toolbar-spacer" />
      <!-- 上下文用量(最后一次 usage 上报,若有) -->
      <span v-if="usageText" class="ctx-usage-text" title="最近一次模型请求的 token 用量">
        {{ usageText }}
      </span>
    </div>

    <!-- 消息流 -->
    <div ref="messagesRef" class="chat-messages">
      <!-- 空态:引导 chips 由父级传入 -->
      <div v-if="emptyVisible" class="empty-state">
        <v-icon size="36" color="muted">mdi-robot-outline</v-icon>
        <div class="empty-title">AI 助手</div>
        <div v-if="suggestions.length" class="ai-guide-prompts">
          <button
            v-for="(suggestion, index) in suggestions"
            :key="index"
            class="ai-guide-chip"
            @click="onSendText(suggestion)"
          >
            <span>{{ suggestion }}</span>
          </button>
        </div>
      </div>

      <!-- 投影块渲染 -->
      <template v-for="block in blocks" :key="block.id">
        <!-- 用户气泡 -->
        <div v-if="block.kind === 'user'" class="msg user" @contextmenu.prevent="onBlockContextMenu($event, block.text)">
          <div class="msg-avatar"><v-icon size="14">mdi-account</v-icon></div>
          <div class="msg-body">
            <div class="msg-meta"><span class="msg-role">你</span></div>
            <div class="msg-content">{{ block.text }}</div>
          </div>
        </div>

        <!-- 助手气泡 -->
        <div v-else-if="block.kind === 'assistant'" class="msg assistant" @contextmenu.prevent="onBlockContextMenu($event, block.text)">
          <div class="msg-avatar"><v-icon size="14">mdi-robot</v-icon></div>
          <div class="msg-body">
            <div class="msg-meta"><span class="msg-role">AI</span></div>
            <AiMessageContent
              :content="assistantContent(block)"
              :parse-think="true"
              :markdown="true"
              :think-label="'思考过程'"
              :run-command="runCommand"
            />
          </div>
        </div>

        <!-- 工具卡片 -->
        <div
          v-else-if="block.kind === 'tool'"
          class="ai-tool-card"
          :class="block.done ? (block.isError ? 'status-error' : 'status-success') : 'status-running'"
        >
          <button type="button" class="ai-tool-head" @click="toggleTool(block.id)">
            <v-icon size="13">
              <template v-if="!block.done">mdi-loading mdi-spin</template>
              <template v-else-if="block.isError">mdi-alert-circle-outline</template>
              <template v-else>mdi-check-circle-outline</template>
            </v-icon>
            <span class="ai-tool-name">{{ block.name || 'tool' }}</span>
            <v-icon size="11" class="ai-tool-chevron">{{ isToolExpanded(block.id) ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
          </button>
          <template v-if="isToolExpanded(block.id)">
            <pre v-if="block.argumentsText" class="ai-tool-pre">{{ shortText(block.argumentsText, 600) }}</pre>
            <pre v-if="block.resultText" class="ai-tool-result">{{ shortText(block.resultText, 600) }}</pre>
          </template>
          <pre v-else-if="block.argumentsText" class="ai-tool-pre one-line">{{ block.argumentsText.replace(/\s+/g, ' ').slice(0, 120) }}</pre>
        </div>

        <!-- 待办清单 -->
        <div v-else-if="block.kind === 'todo'" class="ai-tool-card ai-todo-card">
          <div class="ai-tool-head">
            <v-icon size="13">mdi-format-list-checks</v-icon>
            <span class="ai-tool-name">待办清单</span>
          </div>
          <div v-for="(todo, todoIndex) in block.todos" :key="todoIndex" class="ai-todo-item" :class="`status-${todo.status}`">
            <v-icon size="12">{{ todoIcon(todo.status) }}</v-icon>
            <span>{{ todo.content }}</span>
          </div>
        </div>

        <!-- 通知 -->
        <div v-else-if="block.kind === 'notice'" class="ai-notice">
          <v-icon size="12">mdi-information-outline</v-icon>
          <span>{{ noticeText(block.notice) }}</span>
        </div>

        <!-- 子代理 -->
        <div
          v-else-if="block.kind === 'subagent'"
          class="ai-tool-card"
          :class="block.running ? 'status-running' : (block.ok ? 'status-success' : 'status-error')"
        >
          <div class="ai-tool-head">
            <v-icon size="13">{{ block.running ? 'mdi-loading mdi-spin' : 'mdi-robot-industrial-outline' }}</v-icon>
            <span class="ai-tool-name">子代理任务</span>
            <span v-if="!block.running" class="ai-subagent-status">{{ block.ok ? '完成' : '失败' }}</span>
          </div>
          <pre v-if="block.summary" class="ai-tool-pre">{{ shortText(block.summary, 600) }}</pre>
        </div>

        <!-- 错误 -->
        <div v-else-if="block.kind === 'error'" class="ai-error-bar">
          <v-icon size="14">mdi-alert-circle-outline</v-icon>
          <span>{{ block.message }}({{ block.code }})</span>
        </div>
      </template>

      <!-- 发送链路错误 -->
      <div v-if="sendError" class="ai-error-bar">
        <v-icon size="14">mdi-alert-circle-outline</v-icon>
        <span>{{ sendError }}</span>
      </div>
    </div>

    <!-- 确认 dock(pendingApproval:审批门 / hostkey 确认) -->
    <div v-if="pendingApproval" class="ai-action-dock" aria-live="polite">
      <div class="ai-confirm-card" role="region" aria-label="待确认操作">
        <div class="ai-confirm-head">
          <v-icon size="13">mdi-shield-alert-outline</v-icon>
          <span class="ai-confirm-tool">{{ pendingApproval.toolName || '工具调用' }}</span>
        </div>
        <div v-if="pendingApproval.reason" class="ai-confirm-reason">{{ pendingApproval.reason }}</div>
        <pre v-if="pendingApproval.argumentsText" class="ai-confirm-args">{{ shortText(pendingApproval.argumentsText, 400) }}</pre>
        <div class="ai-confirm-actions">
          <button class="cyber-btn-secondary confirm-btn reject" @click="reject">
            <v-icon size="12">mdi-close</v-icon>
            拒绝
          </button>
          <button class="cyber-btn confirm-btn" @click="approve">
            <v-icon size="12">mdi-check</v-icon>
            批准
          </button>
        </div>
      </div>
    </div>

    <!-- 输入区 -->
    <div class="chat-input">
      <textarea
        v-model="inputText"
        class="cyber-input cyber-input-glow"
        rows="2"
        :placeholder="sending ? 'AI 正在处理…(可发送文字说明或等待)' : placeholder"
        @keydown="onKeydown"
      />
      <button v-if="sending" class="cyber-btn-secondary stop-btn" @click="emit('stop')">
        <v-icon size="14">mdi-stop</v-icon>
        停止
      </button>
      <button class="cyber-btn send-btn" :disabled="!inputText.trim()" @click="onSend">
        <v-icon size="14">mdi-send</v-icon>
        发送
      </button>
    </div>

    <!-- 历史会话存档弹窗 -->
    <v-dialog v-model="historyVisible" max-width="640" scrollable transition="cyber-dialog">
      <div class="cyber-panel ai-history-panel">
        <div class="ai-history-header">
          <button v-if="viewingConv" class="action-btn" data-tooltip="返回列表" aria-label="返回列表" @click="backToList">
            <v-icon size="14">mdi-arrow-left</v-icon>
          </button>
          <span class="ai-history-heading">{{ viewingConv ? `会话消息:${viewingConv.title || '新会话'}` : '历史会话' }}</span>
          <button class="action-btn" data-tooltip="关闭" aria-label="关闭" @click="historyVisible = false">
            <v-icon size="14">mdi-close</v-icon>
          </button>
        </div>

        <!-- 只读消息视图 -->
        <template v-if="viewingConv">
          <div v-if="viewingLoading" class="empty-state">
            <v-icon size="20" class="mdi-spin">mdi-loading</v-icon>
            <div class="empty-desc">加载中…</div>
          </div>
          <div v-else class="ai-history-messages">
            <div v-for="row in viewingMessages" :key="row.rowid" class="history-msg" :class="row.role">
              <span class="history-msg-role">{{ roleLabel(row.role) }}</span>
              <pre class="history-msg-content">{{ messagePreview(row) }}</pre>
            </div>
            <div v-if="viewingMessages.length === 0" class="empty-state">
              <div class="empty-desc">该会话没有消息</div>
            </div>
          </div>
        </template>

        <!-- 会话列表 -->
        <template v-else>
          <div v-if="!isDesktopRuntime" class="empty-state">
            <v-icon size="28" color="muted">mdi-history</v-icon>
            <div class="empty-desc">桌面版中可用</div>
          </div>
          <div v-else-if="historyLoading" class="empty-state">
            <v-icon size="20" class="mdi-spin">mdi-loading</v-icon>
            <div class="empty-desc">加载中…</div>
          </div>
          <div v-else-if="historyError" class="empty-state">
            <div class="empty-desc">{{ historyError }}</div>
          </div>
          <div v-else-if="historyRows.length === 0" class="empty-state">
            <v-icon size="28" color="muted">mdi-message-off-outline</v-icon>
            <div class="empty-desc">还没有历史会话存档</div>
          </div>
          <div v-else class="ai-history-list">
            <div
              v-for="row in historyRows"
              :key="row.id"
              class="tree-item ai-history-item"
              @click="viewConversation(row)"
              @contextmenu.prevent="onHistoryRowContextMenu($event, row)"
            >
              <div class="ai-history-item-main">
                <span class="ai-history-item-title">{{ row.title || '新会话' }}</span>
                <span class="ai-history-item-meta">
                  <span class="cyber-badge">{{ row.message_count }} 条</span>
                  <span class="ai-history-time">{{ formatRelativeTime(row.updated_at) }}</span>
                </span>
              </div>
              <v-icon size="13" class="ai-history-chevron">mdi-chevron-right</v-icon>
            </div>
          </div>
        </template>
      </div>
    </v-dialog>

    <!-- 重命名弹窗 -->
    <v-dialog
      :model-value="renameTarget !== null"
      max-width="420"
      transition="cyber-dialog"
      @update:model-value="(open: boolean) => { if (!open) renameTarget = null }"
    >
      <div class="cyber-panel ai-rename-panel">
        <div class="section-header">
          <span class="section-number">✎</span>
          <h3>重命名会话</h3>
        </div>
        <input v-model="renameValue" class="cyber-input" placeholder="输入新标题…" @keydown.enter="confirmRename" />
        <div class="ai-rename-actions">
          <button class="cyber-btn-secondary" @click="renameTarget = null">取消</button>
          <button class="cyber-btn" @click="confirmRename">保存</button>
        </div>
      </div>
    </v-dialog>

    <!-- 通用右键菜单 -->
    <ContextMenu
      v-if="menuVisible"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @close="closeMenu"
    />
  </div>
</template>

<style scoped>
.ai-dsh-chat {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.chat-toolbar {
  display: flex;
  align-items: center;
  min-width: 0;
  flex-shrink: 0;
  padding: 4px 8px;
  border-bottom: 1px solid var(--line-2);
  background: var(--panel-solid);
}

.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: transparent;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s;
}

.toolbar-btn:hover {
  border-color: var(--cyan);
  color: var(--cyan);
  background: var(--hover-cyan-soft);
}

.toolbar-spacer {
  flex: 1;
}

.ctx-usage-text {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

.chat-messages > * {
  flex-shrink: 0;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 32px 12px;
  color: var(--muted);
  gap: 6px;
  margin-top: 40px;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-2);
}

.ai-guide-prompts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin-top: 14px;
  max-width: 340px;
}

.ai-guide-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.ai-guide-chip:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-2));
}

.msg {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  width: 100%;
  min-width: 0;
}

.msg.user {
  align-self: flex-end;
  max-width: 86%;
  width: auto;
  cursor: context-menu;
}

.msg.assistant {
  cursor: context-menu;
}

.msg-avatar {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  margin-top: 2px;
}

.msg.user .msg-avatar {
  background: var(--icon-bg-cyan);
  border-color: var(--status-connecting-border);
  color: var(--cyan);
}

.msg.assistant .msg-avatar {
  background: var(--icon-bg-purple);
  border-color: var(--line-2);
  color: var(--purple);
}

.msg-body {
  flex: 1;
  min-width: 0;
  max-width: 100%;
}

.msg.user .msg-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.msg-meta {
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 2px;
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
}

.msg-content {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  background: var(--panel-solid);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  padding: 8px 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  min-width: 0;
}

.msg.user .msg-content {
  background: var(--hover-cyan-soft);
  border-color: var(--line-2);
}

/* 工具卡片 */
.ai-tool-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  min-width: 0;
}

.ai-tool-card.status-running {
  border-color: var(--status-connecting-border);
}

.ai-tool-card.status-error {
  border-color: var(--status-error-border);
}

.ai-tool-card.status-success {
  border-color: var(--status-online-border);
}

.ai-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  cursor: pointer;
  color: var(--text-2);
  text-align: left;
  min-width: 0;
}

.ai-tool-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-tool-chevron {
  color: var(--muted);
  flex-shrink: 0;
}

.ai-tool-pre,
.ai-tool-result {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-2);
  background: var(--panel-solid);
  padding: 6px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  max-height: 280px;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}

.ai-tool-pre.one-line {
  max-height: none;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
}

.ai-tool-result {
  color: var(--text-2);
}

.ai-todo-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
}

.ai-todo-item.status-completed {
  color: var(--muted);
  text-decoration: line-through;
}

.ai-todo-item.status-in_progress {
  color: var(--cyan);
}

.ai-subagent-status {
  font-size: 10px;
  color: var(--green);
}

.ai-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  padding: 4px 8px;
}

.ai-error-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--status-error-bg);
  border: 1px solid var(--status-error-border);
  border-radius: 6px;
  font-size: 11px;
  color: var(--red);
  overflow-wrap: anywhere;
}

/* 确认 dock */
.ai-action-dock {
  flex-shrink: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--line-2);
  background: var(--panel-solid);
}

.ai-confirm-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--bg-2);
  border: 1px solid var(--status-connecting-border);
  border-radius: 8px;
}

.ai-confirm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--yellow);
}

.ai-confirm-tool {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono);
}

.ai-confirm-reason {
  font-size: 11px;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ai-confirm-args {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-2);
  background: var(--panel-solid);
  padding: 6px 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  max-height: 200px;
  overflow: auto;
}

.ai-confirm-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.confirm-btn {
  padding: 4px 14px !important;
  font-size: 11px !important;
  white-space: nowrap;
}

.confirm-btn.reject {
  color: var(--red) !important;
  border-color: var(--status-error-border) !important;
}

.confirm-btn.reject:hover {
  background: var(--danger-hover-bg) !important;
}

/* 输入区 */
.chat-input {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--line-2);
  background: var(--panel-solid);
  align-items: flex-end;
  min-width: 0;
  flex-shrink: 0;
}

.chat-input textarea {
  flex: 1;
  min-width: 0;
  resize: none;
  min-height: 36px;
  max-height: 120px;
  font-family: inherit;
  font-size: 12px;
}

.send-btn {
  padding: 6px 12px !important;
  font-size: 12px !important;
  white-space: nowrap;
  flex-shrink: 0;
}

.stop-btn {
  padding: 6px 12px !important;
  font-size: 12px !important;
  white-space: nowrap;
  flex-shrink: 0;
  color: var(--red) !important;
  border-color: var(--status-error-border) !important;
}

.stop-btn:hover {
  background: var(--danger-hover-bg) !important;
}

/* 历史弹窗 */
.ai-history-panel {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 70vh;
}

.ai-history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ai-history-heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-history-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.ai-history-item {
  gap: 6px;
  cursor: pointer;
}

.ai-history-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ai-history-item-title {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-history-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-history-time {
  font-size: 10px;
  color: var(--muted);
}

.ai-history-chevron {
  color: var(--muted);
  align-self: center;
  flex-shrink: 0;
}

.ai-history-messages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
}

.history-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.history-msg-role {
  font-size: 10px;
  color: var(--muted);
  font-family: var(--font-mono);
}

.history-msg-content {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 6px 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
}

.ai-rename-panel {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-rename-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

@media (max-width: 360px) {
  .chat-input {
    flex-direction: column;
    align-items: stretch;
  }

  .send-btn,
  .stop-btn {
    justify-content: center;
  }
}
</style>
