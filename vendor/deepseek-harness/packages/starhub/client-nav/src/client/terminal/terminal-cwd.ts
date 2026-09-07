/**
 * Terminal current-directory tracking for the shell-native SSH overlay.
 *
 * Pure port of the Vue `src/utils/terminalCwd.ts` + the cwd-relevant parts of
 * `src/utils/sshPromptCapture.ts` and `SshTerminal.vue`. Tracks the remote cwd
 * from two signals in the PTY stream — the shell's own OSC 7 (`ESC ] 7 ; <cwd>`
 * BEL) and `pwd` output lines — and optionally lazy-injects an OSC 7 hook into
 * the running shell so `cd` reports cwd live (the SFTP「跟随终端」flow).
 *
 * @module StarHub terminal cwd tracking (client)
 */

/** Inject the OSC 7 hook into the running shell (ends with newline to run). */
export const OSC7_INJECT_COMMAND =
  '__starhub_osc7() { printf \'\\033]7;%s\\007\' "$PWD"; }; ' +
  'if [ -n "${ZSH_VERSION:-}" ]; then precmd_functions+=(__starhub_osc7); ' +
  'else PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__starhub_osc7"; fi\n'

/** Stable substring of the inject-command echo line (hidden by the render filter). */
export const OSC7_INJECT_ECHO_TEXT = '__starhub_osc7'

/** Max tail length kept because OSC sequences may straddle TCP fragments. */
const OSC7_TAIL_KEEP = 512

/**
 * Extract the latest complete OSC 7 cwd from a tail; return cwd + unconsumed rest.
 * @param tail - the buffered terminal tail (may contain partial OSC sequences).
 * @returns the latest complete cwd (null when none) and the unconsumed rest.
 */
export function extractOsc7Cwd(tail: string): { cwd: string | null; rest: string } {
  const re = /\x1b\]7;([^\x07\x1b]{1,300})(?:\x07|\x1b\\)/g
  let cwd: string | null = null
  let consumed = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(tail)) !== null) {
    const captured = m[1]
    /* v8 ignore next -- the OSC 7 capture group requires 1-300 chars, so m[1] is always defined */
    if (captured === undefined) continue
    let p = captured
    const fileMatch = p.match(/^file:\/\/[^/]*(\/.*)$/)
    const pathPart = fileMatch?.[1]
    if (pathPart !== undefined) p = pathPart
    if (p.startsWith('/')) cwd = p
    consumed = re.lastIndex
  }
  return { cwd, rest: tail.slice(consumed).slice(-OSC7_TAIL_KEEP) }
}

/**
 * Parse the first line starting with `/` from `pwd` output (login dir).
 * @param output - the raw `pwd` output text.
 * @returns the first absolute path line, or null when none.
 */
export function parsePwdOutput(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('/')) return trimmed
  }
  return null
}

/**
 * Strip ANSI control sequences and BEL.
 * @param input - the raw terminal text.
 * @returns the text with control sequences removed.
 */
export function stripTerminalControl(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\x07/g, '')
}

/**
 * Strip control sequences and normalize \r\n / \r to \n.
 * @param input - the raw terminal text.
 * @returns the normalized text.
 */
export function normalizeTerminalText(input: string): string {
  return stripTerminalControl(input)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * Whether a line looks like a shell prompt (bash/sh/zsh/fish formats).
 * @param line - the line to classify.
 * @returns true when the line is a plausible shell prompt.
 */
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

/** 抑制窗口内的缓冲安全上限(字节):注入命令回显只有一行(约 200 字节),
 *  窗口内积压超过上限说明回显不会到来(远端 echo 关闭 / 注入丢失),
 *  冲刷积压并解除,避免持续吞掉用户输出。 */
const ARMED_BUFFER_CAP = 8192

/** 一次性武装的隐藏回显过滤器。
 *
 * 默认(未武装)**零缓冲透传**——常驻过滤会把任何以 marker 前缀
 * (`_` / `__` / `__s` …,marker `__starhub_osc7` 以下划线开头)结尾的
 * 未完成行扣到下一个 chunk 才放行,交互式 bash 逐字节回显时表现为
 * 「行尾下划线丢失 / 下个字符到达时一次蹦出两个」。因此只在写入
 * OSC 7 注入命令前 `arm()`,含 marker 的回显行被剔除后窗口自动结束;
 * `disarm()` 供注入失败时立即解除并取回扣留文本。
 */
export interface HiddenEchoFilter {
  /** 处理一个输出 chunk,返回应渲染的文本(武装期间可能扣留未完成行)。 */
  (chunk: string): string
  /** 进入抑制窗口(写入注入命令前调用)。 */
  arm(): void
  /** 立即结束抑制窗口,@returns 扣留中的文本(调用方负责渲染)。 */
  disarm(): string
  /** 当前是否处于抑制窗口。 */
  isArmed(): boolean
}

/**
 * 创建跨 chunk 保持状态的一次性隐藏回显过滤器(回显行可能跨 TCP 分片)。
 * 武装期间:完整逻辑行含任一字面量则整行剔除并结束窗口(注入回显只有
 * 一行,以命令末尾的 `\n` 收束);无换行前缀不再做 marker 前缀重叠扣留。
 * @param literals - substrings of lines to drop.
 * @returns 过滤器(默认未武装,透传)。
 */
export function createHiddenEchoFilter(literals: string[]): HiddenEchoFilter {
  const markers = literals.filter(lit => lit.length > 0)
  let armed = false
  let pending = ''

  const filter = ((chunk: string): string => {
    if (!armed) return chunk
    pending += chunk
    let out = ''
    let nl = pending.indexOf('\n')
    while (nl >= 0) {
      const line = pending.slice(0, nl + 1)
      pending = pending.slice(nl + 1)
      if (markers.some(lit => line.includes(lit))) {
        // 注入回显已消费:窗口使命完成,冲刷剩余并解除武装。
        armed = false
        out += pending
        pending = ''
        return out
      }
      out += line
      nl = pending.indexOf('\n')
    }
    if (pending.length >= ARMED_BUFFER_CAP) {
      out += pending
      pending = ''
      armed = false
    }
    return out
  }) as HiddenEchoFilter

  filter.arm = () => {
    armed = true
  }
  filter.disarm = () => {
    armed = false
    const held = pending
    pending = ''
    return held
  }
  filter.isArmed = () => armed
  return filter
}

/** Stateful cwd tracker: consume terminal chunks and yield the latest cwd. */
export interface CwdTracker {
  /** Feed one decoded text chunk; returns the updated cwd (null if unchanged). */
  onChunk(chunk: string): string | null
  /** Report a full line/path (e.g. from `pwd` output) as the cwd. */
  set(cwd: string): void
  /** Current best-known cwd (may be empty until first signal). */
  get(): string
}

/**
 * Create a cwd tracker that parses OSC 7 + `pwd` output across fragments.
 * @returns the tracker handle.
 */
export function createCwdTracker(): CwdTracker {
  let cwd = ''
  let tail = ''
  return {
    onChunk(chunk) {
      tail += chunk
      const osc7 = extractOsc7Cwd(tail)
      tail = osc7.rest
      let changed = false
      if (osc7.cwd !== null && osc7.cwd !== cwd) {
        cwd = osc7.cwd
        changed = true
      }
      // pwd output fallback: a line that is just an absolute path
      const pwdMatch = chunk.match(/(?:\r\n|\n|\r)(\/[\w\-./]{1,200})\s*(?:\r\n|\n|\r|$)/)
      const pwdPath = pwdMatch?.[1]
      if (pwdPath !== undefined && pwdPath.startsWith('/') && pwdPath !== cwd) {
        cwd = pwdPath
        changed = true
      }
      return changed ? cwd : null
    },
    set(next) {
      if (next !== cwd) cwd = next
    },
    get() {
      return cwd
    },
  }
}
