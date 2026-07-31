<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

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
}>(), {
  parseThink: false,
  markdown: false
})

marked.setOptions({ gfm: true, breaks: true })

/** Markdown → HTML → DOMPurify 消毒,杜绝 XSS。 */
function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string
  return DOMPurify.sanitize(html)
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
    ? renderMarkdown(part.content)
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
      <div v-else-if="part.html" class="ai-message-markdown" v-html="part.html" />
      <span v-else class="ai-message-text">{{ part.content }}</span>
    </template>
  </div>
</template>
