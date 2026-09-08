/**
 * 终端 cwd 跟踪(SFTP「跟随终端」/ AI 上下文共用)的纯函数部分。
 *
 * 建链后用静默 exec 通道跑 pwd 拿登录目录;之后前端在终端输出流里解析
 * 三类信号持续更新 cwd:远端 shell 自身 shell integration 发出的 OSC 7
 * 转义序列(ESC ] 7 ; <cwd> BEL,不注入、不修改远端任何配置)、shell
 * prompt 行内携带的路径(默认 PS1 形态,配合登录 home 展开 ~),以及
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

/** 建链静默探测输出中可识别的登录 shell 名(comm,小写)。 */
const KNOWN_LOGIN_SHELLS: ReadonlySet<string> = new Set([
  'bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'nushell', 'ion', 'elvish', 'xonsh',
])

/** 对 OSC 7 注入免疫的 shell(注入命令只会打出错误行):不注入,靠 prompt 路径提取兜底。 */
const INJECTION_IMMUNE_SHELLS: ReadonlySet<string> = new Set(['csh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'nushell', 'ion', 'elvish', 'xonsh'])

/** fish 专用的 OSC 7 上报 hook(fish 不支持 PROMPT_COMMAND 语法,走 fish_prompt 事件)。 */
const FISH_INJECT_COMMAND =
  'function __starhub_osc7 --on-event fish_prompt; printf \'\\033]7;%s\\007\' $PWD; end\n'

/**
 * 从建链静默探测输出(`pwd; echo $0; ps -p $$ -o comm=`)解析登录 shell 名。
 * 逐行找第一个命中已知集合的短 token;`/bin/bash`、`-bash` 等 argv0 变体先取 basename、剥前导 `-`。
 * @param output - 静默 exec 的原始输出。
 * @returns 小写 shell 名(如 `bash` / `fish`);无可识别行时 null。
 */
export function parseLoginShell(output: string): string | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('/')) continue
    const base = trimmed.replace(/^.*[/\\]/, '').replace(/^-+/, '').toLowerCase()
    if (KNOWN_LOGIN_SHELLS.has(base)) return base
  }
  return null
}

/**
 * 按登录 shell 类型生成 OSC 7 上报 hook 的注入命令。
 * @param shell - parseLoginShell 的结果;null 表示未探测到(保守按 bash/zsh 处理)。
 * @returns 注入命令(末尾 \n 即回车执行);`''` 表示该 shell 无可用 hook,不应注入。
 */
export function buildOsc7InjectCommand(shell: string | null): string {
  if (shell !== null && INJECTION_IMMUNE_SHELLS.has(shell)) return ''
  if (shell === 'fish') return FISH_INJECT_COMMAND
  return OSC7_INJECT_COMMAND
}

/**
 * 从(已剥离控制序列的)shell prompt 行提取工作目录路径。
 * 识别 `/...` 绝对路径与 `~` / `~/...`(用 home 展开;home 未知时不猜)。
 * 这是 OSC 7 注入之外的第二条 cwd 信号,覆盖默认 PS1(`\u@\h:\w\$`、`[root@host ~]#`)等
 * 注入未生效的场景;取行内最后一个路径 token(离提示符最近的是 cwd)。
 * @param line - stripTerminalControl 后的 prompt 行。
 * @param home - 远端 home(绝对路径);空串表示未知。
 * @returns 绝对路径;无可还原路径时 null。
 */
export function extractPromptCwd(line: string, home: string): string | null {
  const re = /(?:^|[\s:\[(])(\/[^\s\]\)#$%]{1,200}|~(?:\/[^\s\]\)#$%]{1,200})?)/g
  let found: string | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const token = m[1]
    if (token === undefined) continue
    // 排除 `//`(协议相对 URL/UNC 形式);POSIX 合法路径几乎不以 // 开头
    if (token.startsWith('//')) continue
    found = token
  }
  if (found === null) return null
  if (found === '~') return home.startsWith('/') ? home : null
  if (found.startsWith('~/')) {
    if (!home.startsWith('/')) return null
    return (home === '/' ? '' : home) + found.slice(1)
  }
  return found
}
