<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useI18n } from 'vue-i18n'
import { useNotifyStore } from '@/stores/notify'

type MessagePart = {
  kind: 'text' | 'think'
  content: string
}

const props = withDefaults(defineProps<{
  content: string
  parseThink?: boolean
  /** true 时普通文本部分按 Markdown 渲染(DOMPurify 消毒后 v-html) */
  markdown?: boolean
  thinkLabel: string
  /** 宿主提供后,代码块右上角显示「执行」按钮,点击把命令交给宿主(如 SSH 终端)执行 */
  runCommand?: (command: string) => void
}>(), {
  parseThink: false,
  markdown: false
})

const { t } = useI18n()
const notifyStore = useNotifyStore()

marked.setOptions({ gfm: true, breaks: true })

/** Markdown → HTML → DOMPurify 消毒,杜绝 XSS。 */
function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html)
}

/**
 * 给每个代码块 `<pre>` 包一层头部(语言标签 + 复制按钮 + 可选执行按钮)。
 * 输入已过 DOMPurify,这里追加的按钮是自有静态 HTML(非用户内容),安全。
 */
function decorateCodeBlocks(html: string): string {
  if (!html.includes('<pre')) return html
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild as HTMLElement | null
  if (!root) return html
  root.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code')
    const lang = code?.className.match(/language-([\w-]+)/)?.[1] ?? ''
    const wrap = doc.createElement('div')
    wrap.className = 'ai-code-block'
    const head = doc.createElement('div')
    head.className = 'ai-code-block-head'
    const langLabel = doc.createElement('span')
    langLabel.className = 'ai-code-lang'
    langLabel.textContent = lang || 'code'
    head.appendChild(langLabel)
    const actions = doc.createElement('div')
    actions.className = 'ai-code-actions'
    const copyBtn = doc.createElement('button')
    copyBtn.type = 'button'
    copyBtn.className = 'ai-code-action ai-code-copy'
    copyBtn.dataset.aiAction = 'copy'
    copyBtn.title = t('ai.copyCode')
    copyBtn.textContent = t('ai.copyCode')
    actions.appendChild(copyBtn)
    if (props.runCommand) {
      const runBtn = doc.createElement('button')
      runBtn.type = 'button'
      runBtn.className = 'ai-code-action ai-code-run'
      runBtn.dataset.aiAction = 'run'
      runBtn.title = t('ai.runCommandTip')
      runBtn.textContent = t('ai.runCommand')
      actions.appendChild(runBtn)
    }
    head.appendChild(actions)
    wrap.appendChild(head)
    pre.parentNode?.insertBefore(wrap, pre)
    wrap.appendChild(pre)
  })
  return root.innerHTML
}

/** 代码块按钮点击(事件委托):复制 / 执行。 */
async function handleContentClick(event: MouseEvent): Promise<void> {
  const btn = (event.target as HTMLElement).closest('button[data-ai-action]') as HTMLElement | null
  if (!btn) return
  const block = btn.closest('.ai-code-block') as HTMLElement | null
  if (!block) return
  const code = block.querySelector('code')
  const text = code?.textContent ?? ''
  const action = btn.dataset.aiAction
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(text)
      notifyStore.notify({ message: t('ai.copied'), color: 'success', timeout: 1500 })
    } catch {
      notifyStore.notify({ message: t('ai.copyFailed'), color: 'warning', timeout: 2000 })
    }
  } else if (action === 'run' && props.runCommand) {
    props.runCommand(text)
  }
}

/** Split model reasoning from the visible answer without rendering untrusted HTML. */
function parseThinkContent(content: string): MessagePart[] {
  if (!props.parseThink) return [{ kind: 'text', content }]

  const parts: MessagePart[] = []
  const openingTag = /<think(?:\s[^>]*)?>/gi
  let cursor = 0
  let opening: RegExpExecArray | null

  while ((opening = openingTag.exec(content)) !== null) {
    if (opening.index > cursor) {
      parts.push({ kind: 'text', content: content.slice(cursor, opening.index) })
    }

    const bodyStart = opening.index + opening[0].length
    const remainder = content.slice(bodyStart)
    const closing = /<\/think\s*>/i.exec(remainder)
    if (!closing) {
      parts.push({ kind: 'think', content: remainder.trim() })
      cursor = content.length
      break
    }

    parts.push({ kind: 'think', content: remainder.slice(0, closing.index).trim() })
    cursor = bodyStart + closing.index + closing[0].length
    openingTag.lastIndex = cursor
  }

  if (cursor < content.length) parts.push({ kind: 'text', content: content.slice(cursor) })
  return parts.length ? parts : [{ kind: 'text', content }]
}

const parts = computed(() => parseThinkContent(props.content))
const hasThink = computed(() => parts.value.some(part => part.kind === 'think'))
const renderedParts = computed(() => parts.value.map(part => ({
  ...part,
  html: part.kind === 'text' && props.markdown && part.content.trim()
    ? decorateCodeBlocks(renderMarkdown(part.content))
    : ''
})))
</script>

<template>
  <div class="ai-message-content" :class="{ 'ai-message-segmented': hasThink }">
    <template v-for="(part, index) in renderedParts" :key="`${part.kind}-${index}`">
      <details v-if="part.kind === 'think'" class="ai-think-block">
        <summary class="ai-think-summary">
          <v-icon class="ai-think-chevron" size="14">mdi-chevron-right</v-icon>
          <span>{{ thinkLabel }}</span>
        </summary>
        <pre class="ai-think-content">{{ part.content }}</pre>
      </details>
      <div v-else-if="part.html" class="ai-message-markdown" v-html="part.html" @click="handleContentClick" />
      <span v-else class="ai-message-text">{{ part.content }}</span>
    </template>
  </div>
</template>
