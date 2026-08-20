/**
 * 终端 cwd 跟踪(SFTP「跟随终端」/ AI 上下文共用)的纯函数部分。
 *
 * 建链后用静默 exec 通道跑 pwd 拿登录目录;之后前端在终端输出流里解析
 * 两类信号持续更新 cwd:远端 shell 自身 shell integration 发出的 OSC 7
 * 转义序列(ESC ] 7 ; <cwd> BEL,不注入、不修改远端任何配置),以及
 * sh/dash/fish 等无 hook shell 下 pwd 输出的逐行解析兜底。
 */

/**
 * 注入远端 shell 的 OSC 7 初始化命令(末尾 \n 即回车执行)。
 * 只影响当前 shell 会话(追加 PROMPT_COMMAND / precmd_functions),不写远端任何配置文件。
 *
 * 使用约束(懒注入):绝不在建链 / MFA 阶段写入,只在 SFTP「跟随终端」开启
 * 且输出流中已检测到 shell prompt 后注入;命令回显由渲染过滤器
 * (createHiddenEchoFilter + OSC7_INJECT_ECHO_TEXT)整行隐藏,用户不可见。
 */
export const OSC7_INJECT_COMMAND =
  '__starhub_osc7() { printf \'\\033]7;%s\\007\' "$PWD"; }; ' +
  'if [ -n "${ZSH_VERSION:-}" ]; then precmd_functions+=(__starhub_osc7); ' +
  'else PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__starhub_osc7"; fi\n'

/** 注入命令回显行里的稳定子串(渲染过滤器据此整行剔除) */
export const OSC7_INJECT_ECHO_TEXT = '__starhub_osc7'

/** 滚动 tail 最大保留长度(转义序列可能跨 TCP 分片,保留未消费尾部) */
const OSC7_TAIL_KEEP = 512

/**
 * 从滚动 tail 中提取完整的 OSC 7 cwd 上报。
 * 返回最新一个 cwd(无则 null)与未消费完的残余 tail(供下一分片继续拼)。
 * 兼容标准 `file://host/path` 形式与裸路径形式。
 */
export function extractOsc7Cwd(tail: string): { cwd: string | null; rest: string } {
  const re = /\x1b\]7;([^\x07\x1b]{1,300})(?:\x07|\x1b\\)/g
  let cwd: string | null = null
  let consumed = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(tail)) !== null) {
    let p = m[1]
    const fileMatch = p.match(/^file:\/\/[^/]*(\/.*)$/)
    if (fileMatch) p = fileMatch[1]
    if (p.startsWith('/')) cwd = p
    consumed = re.lastIndex
  }
  return { cwd, rest: tail.slice(consumed).slice(-OSC7_TAIL_KEEP) }
}

/**
 * 从静默 exec 的 `pwd` 输出中解析目录(取第一个以 / 开头的行)。
 * 用于建链后立刻拿到登录目录,让 SFTP「跟随终端」开关无需用户先敲 pwd 即可用。
 */
export function parsePwdOutput(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('/')) return trimmed
  }
  return null
}
