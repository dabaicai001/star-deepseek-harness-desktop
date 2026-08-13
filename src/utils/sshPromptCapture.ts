// ============================================================
// SSH PTY prompt 捕获的纯函数(供 SshTerminal.vue AI 工具执行路径使用)
//
// 背景:AI 命令写进交互终端后,靠「shell prompt 重新出现」判断命令结束。
// 两个容易踩的坑:
// 1. 长命令按终端宽度折行回显,尾部片段(如 `.../stdout.log 2>`)
//    外形像 prompt(路径 + 结尾 >),会被误判为 prompt 已返回;
// 2. sleep / 下载等命令长时间无输出,不能用「数据流静默」提前收口
//    (该兜底只在 prompt 无法识别时由调用方启用)。
// ============================================================

/** 剥离 ANSI 控制序列与 BEL,避免干扰行匹配 */
export function stripTerminalControl(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\x07/g, '')
}

/** 剥离控制序列并把 \r\n / \r 统一成 \n */
export function normalizeTerminalText(input: string): string {
  return stripTerminalControl(input)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

// ============================================================
// 命令完成哨兵(completion marker)
//
// 借鉴 OpenHands(tmux 会话追加完成标记)与 Roo Code(PowerShell counter
// workaround)的做法:命令发出后追加一行
//   printf '\033]777;starhub;ai-done;<ID>;%s\007' "$?"
// 在 PTY 原始字节流里精确匹配哨兵判断命令结束并取到退出码,
// 不再只依赖「shell prompt 重新出现」的启发式识别。
//
// 为什么用 OSC 转义序列而不是纯文本标记:
// - xterm.js 对未知 OSC 序列只解析不渲染,用户终端里完全不可见,
//   不会像纯文本标记那样在 scrollback 里留下噪音行;
// - 唯一 ID 避免误命中命令输出里恰好出现的同类字节(如 tail 的日志里
//   嵌了别的终端会话的 OSC 133);
// - 哨兵行被吞(引号未闭合、csh/PowerShell 无 printf 等)时,
//   调用方自动退回原有的 prompt 识别 + 安全超时,行为与旧版一致。
//
// 这一版同时治好了多行命令的两个老毛病:
// - for/if/heredoc 的 PS2 `>` 续行回显干扰 prompt 识别;
// - 命令末行输出不带换行时 prompt 与输出粘连成一行,永远匹配不上。
// ============================================================

/** 哨兵 OSC 载荷命名空间(自定义 OSC 777,xterm.js 不渲染) */
const COMPLETION_MARKER_NS = 'starhub;ai-done'

/** 生成单次命令唯一的哨兵 ID */
export function newCompletionMarkerId(seq: number): string {
  return `${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 生成追加在 AI 命令之后的哨兵命令(独立一行,兼容多行命令)。
 * 同一行 printf 顺路上报 OSC 7 cwd(`$?` 与 `$PWD` 在 printf 执行前同时展开,
 * 语义不变):AI 每执行一条命令,cwd 立即刷新,无需向 shell 注入任何 hook;
 * 回显行由渲染过滤器(COMPLETION_MARKER_ECHO_TEXT)整行隐藏。
 */
export function buildCompletionMarkerCommand(markerId: string): string {
  return `printf '\\033]777;${COMPLETION_MARKER_NS};${markerId};%s\\007\\033]7;%s\\007' "$?" "$PWD"`
}

export interface CompletionMarkerMatch {
  /** 哨兵序列在 raw 中的起始下标 */
  start: number
  /** 命令退出码;部分 shell(如 fish)不展开 `$?` 时为 null */
  exitCode: number | null
}

/**
 * 在 PTY 原始输出中查找哨兵。
 * 真实输出是 ESC]777;<ns>;<ID>;<退出码> BEL(或 ESC\ 结尾);
 * 命令回显里只有字面文本 `\033]777;...`(没有 ESC 字节),不会误匹配。
 * `$?` 未展开的 shell(fish 等)退出码为空字符串,退化为无退出码。
 */
export function findCompletionMarker(raw: string, markerId: string): CompletionMarkerMatch | null {
  const pattern = new RegExp(`\\x1B\\]777;${COMPLETION_MARKER_NS};${markerId};(\\d{0,3})(?:\\x07|\\x1B\\\\)`)
  const match = pattern.exec(raw)
  if (!match) return null
  return { start: match.index, exitCode: match[1] ? Number(match[1]) : null }
}

/** 判断一行是否是哨兵命令的回显行(清理 AI 侧输出时剔除) */
export function isCompletionMarkerEchoLine(line: string): boolean {
  return line.includes(`777;${COMPLETION_MARKER_NS}`)
}

/**
 * 渲染侧回显过滤:AI 哨兵命令 / OSC 7 注入命令写入 PTY 后,shell readline
 * 会把命令文本回显到终端(`\033` 是反斜杠字面文本,与真实 OSC 序列的
 * ESC 字节相区分),scrollback 里留下一行内部实现细节,对用户不友好。
 * xterm 对真实 OSC 序列只解析不渲染,无需处理;这里把含指定字面量的
 * 完整逻辑行整行剔除,哨兵 / 注入机制本身照常执行。
 */

/** AI 完成哨兵命令回显行里的稳定子串 */
export const COMPLETION_MARKER_ECHO_TEXT = `\\033]777;${COMPLETION_MARKER_NS}`

/**
 * 创建跨 chunk 保持状态的渲染过滤器(回显行可能跨 TCP 分片)。
 * 命中任一字面量的完整逻辑行整行剔除;未完成行出现完整 marker 或
 * 其 ≥8 字符前缀时扣留整行等 \n(marker 可能从行中间开始并跨分片),
 * 仅尾部与 marker 开头重叠时只扣留重叠段——无换行的 prompt 行实时放行。
 */
export function createHiddenEchoFilter(literals: string[]): (chunk: string) => string {
  let pending = ''
  const markers = literals.filter(lit => lit.length > 0)
  const longest = markers.reduce((max, lit) => Math.max(max, lit.length), 0)
  const PARTIAL_HEAD = 8

  /** buf 尾部与任一 marker 前缀的最长重叠长度(跨分片的 marker 开头) */
  function markerPrefixOverlap(buf: string): number {
    const max = Math.min(buf.length, longest - 1)
    for (let k = max; k > 0; k--) {
      if (markers.some(lit => k < lit.length && buf.endsWith(lit.slice(0, k)))) return k
    }
    return 0
  }

  return (chunk: string): string => {
    pending += chunk
    let out = ''
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl + 1)
      pending = pending.slice(nl + 1)
      if (!markers.some(lit => line.includes(lit))) out += line
    }
    if (!pending) return out
    // 完整 marker,或 marker 的可疑前缀(≥ PARTIAL_HEAD,覆盖从行中间开始、
    // 后半截还在路上的情况):扣留整行,等 \n 到了做整行剔除判定
    const hit = markers.some(lit =>
      pending.includes(lit) || pending.includes(lit.slice(0, Math.min(lit.length, PARTIAL_HEAD)))
    )
    if (hit) return out
    // 尾部可能是 marker 的开头(< PARTIAL_HEAD,前缀判断还无法命中),扣留重叠段
    const keep = markerPrefixOverlap(pending)
    out += pending.slice(0, pending.length - keep)
    pending = pending.slice(pending.length - keep)
    return out
  }
}

/** 判断一行是否像 shell prompt(常见 bash/sh/zsh/fish 格式) */
export function isShellPromptLine(line: string): boolean {
  const trimmed = line.trimEnd()
  if (!trimmed || trimmed.length > 180) return false
  if (/^[#$%>]\s*$/.test(trimmed)) return true
  if (/^\[[^\]\n]{1,140}\]\s*[#$%>]\s*$/.test(trimmed)) return true
  if (/^[\w.-]+@[\w.-]+(?::[^\n]{0,120})?\s*[#$%>]\s*$/.test(trimmed)) return true
  if (/^(?:~|\/[\w./-]*|\.\.?)(?:\s+[^\n]{0,80})?\s*[#$%>]\s*$/.test(trimmed)) return true
  if (/(?:❯|➜)\s*$/.test(trimmed)) return true
  return false
}

function flattenInline(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * 判断一行是否是 command 回显(可能按终端宽度折行)的片段:
 * 去掉全部空白后是命令(同样去空白)的子串。
 * 折行回显的尾部片段形如 `/root/.../stdout.log 2>`,会被
 * isShellPromptLine 误判成 prompt,用这个守卫排除。
 */
export function isCommandEchoFragment(line: string, command: string): boolean {
  const flatLine = flattenInline(line)
  if (!flatLine) return false
  return flattenInline(command).includes(flatLine)
}

/**
 * 判断捕获到的输出里 shell prompt 是否已重新出现(即命令已结束)。
 * - 优先与命令发送前记录的 expectedPrompt 精确相等(兼容自定义 PS1)
 * - 否则回退到通用 prompt 模式,但排除命令折行回显的尾部片段
 */
export function hasReturnedPrompt(raw: string, expectedPrompt: string | null, command?: string): boolean {
  const text = normalizeTerminalText(raw).slice(-1200)
  const lines = text.split('\n').map(line => line.trimEnd()).filter(line => line.trim().length > 0)
  const last = lines[lines.length - 1] || ''
  if (expectedPrompt && last === expectedPrompt) return true
  if (!isShellPromptLine(last)) return false
  if (command && isCommandEchoFragment(last, command)) return false
  return true
}

/** 命令超过终端宽度时回显折成多行,单行匹配剥不掉;按拼接前缀整体剥离 */
const MAX_ECHO_WRAP_LINES = 50

function stripWrappedEchoLines(lines: string[], commandText: string): void {
  const flatCmd = flattenInline(commandText)
  if (!flatCmd) return
  let flat = ''
  let consumed = 0
  while (consumed < lines.length && consumed < MAX_ECHO_WRAP_LINES && flat.length < flatCmd.length) {
    // 首行回显带 prompt 前缀,整体拼接后以完整命令结尾即为回显段
    flat += flattenInline(lines[consumed].trim())
    consumed++
    if (flat.endsWith(flatCmd)) {
      lines.splice(0, consumed)
      return
    }
  }
}

/**
 * 从 prompt 捕获的原始输出中提取命令真实输出:
 * 剥掉开头的命令回显(单行或折行)、结尾的 prompt 行,并脱敏用户输入过的敏感内容。
 */
export function cleanPromptCapturedOutput(raw: string, command: string, sensitiveInputs?: Set<string>): string {
  const commandText = command.trim()
  const lines = normalizeTerminalText(raw)
    .split('\n')
    .map(line => line.trimEnd())

  while (lines.length && !lines[0].trim()) lines.shift()
  if (lines.length && commandText) {
    const first = lines[0].trim()
    if (first === commandText || first.endsWith(commandText)) {
      lines.shift()
    } else {
      stripWrappedEchoLines(lines, commandText)
    }
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  if (lines.length && isShellPromptLine(lines[lines.length - 1])) {
    lines.pop()
  }
  let output = lines.join('\n').trim()
  if (sensitiveInputs) {
    for (const secret of sensitiveInputs) {
      if (secret) output = output.split(secret).join('[REDACTED]')
    }
    sensitiveInputs.clear()
  }
  return output
}
