/**
 * SSH 命令可执行性策略(供 dsh 域工具执行器与终端宿主共用)。
 *
 * PTY / exec channel 只能可靠执行会自行结束的命令;提前拒绝会占用标准输入、
 * 持续刷新或等待键盘输入的命令,避免 AI 工作流假完成或一直等到安全超时。
 */

interface UnsupportedSshCommandPattern {
  pattern: RegExp
  reason: string
}

const UNSUPPORTED_INTERACTIVE_SSH_COMMANDS: UnsupportedSshCommandPattern[] = [
  {
    pattern: /(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?(?:vi|vim|nvim|nano|emacs|less|more|man)(?:\s|$)/i,
    reason: '编辑器或分页器需要持续键盘输入'
  },
  {
    pattern: /(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?(?:watch|htop)(?:\s|$)/i,
    reason: '持续刷新的命令不会自行返回 shell prompt'
  },
  {
    pattern: /\b(?:tail|journalctl)\b[^\n;&]*(?:\s-f\b|\s--follow(?:=\S+)?\b)/i,
    reason: '持续跟随输出的命令不会自行结束'
  },
  {
    pattern: /\b(?:docker|kubectl)\s+logs\b[^\n;&]*(?:\s-f\b|\s--follow\b)/i,
    reason: '持续跟随日志的命令不会自行结束'
  },
  {
    pattern: /(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?(?:read|passwd)(?:\s|$)/i,
    reason: '命令会等待交互式标准输入'
  }
]

function findHereDocument(command: string): { delimiter: string; complete: boolean } | null {
  const match = command.match(/<<-?\s*(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([A-Za-z_][A-Za-z0-9_]*))/)
  if (!match) return null
  const delimiter = match[1] ?? match[2] ?? match[3]
  const remainingLines = command
    .slice((match.index ?? 0) + match[0].length)
    .replace(/\r\n?/g, '\n')
    .split('\n')
  const complete = remainingLines.some(line => line.replace(/^\t+/, '').trimEnd() === delimiter)
  return { delimiter, complete }
}

/**
 * 返回该命令不可执行的原因(null 表示可执行)。
 */
export function getUnsupportedSshCommandReason(command: string): string | null {
  const normalized = command.trim()
  const hereDocument = findHereDocument(normalized)

  if (hereDocument && !hereDocument.complete) {
    return `heredoc 缺少结束标记 ${hereDocument.delimiter}`
  }

  // `cat > file` 没有文件输入或完整 heredoc 时会从 PTY 持续读取 stdin。
  // 单管道 `printf ... | cat > file` 不在命令段边界内,因此不会被误拦截。
  const catReadsStdin = /(?:^|&&|\|\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?cat(?:\s+(?:-[A-Za-z]+|-))*\s*>{1,2}\s*\S+/i.test(normalized)
    || /(?:^|&&|\|\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?cat\s+(?:-|\/dev\/stdin)\b[^\n;&]*>{1,2}/i.test(normalized)
  if (catReadsStdin && !hereDocument?.complete) {
    return 'cat 输出重定向没有输入内容,会一直等待标准输入;请改用包含完整正文和结束标记的 heredoc,或使用 printf'
  }

  const topMatch = normalized.match(/(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?top\b([^\n;&|]*)/i)
  if (topMatch && !/(?:^|\s)(?:-b|--batch)(?:\s|$)/i.test(topMatch[1])) {
    return 'top 默认进入交互界面;请使用 top -b -n1 等 batch 模式'
  }

  const pingMatch = normalized.match(/(?:^|&&|\|\||\||;|\n)\s*(?:sudo(?:\s+-\S+)*\s+)?ping\b([^\n;&|]*)/i)
  if (pingMatch && !/(?:^|\s)(?:-c\s*\d+|-w\s*\d+|-W\s*\d+)(?:\s|$)/i.test(pingMatch[1])) {
    return 'ping 未设置次数或截止时间;请使用 ping -c <次数> 或 -w <秒数>'
  }

  for (const item of UNSUPPORTED_INTERACTIVE_SSH_COMMANDS) {
    if (item.pattern.test(normalized)) return item.reason
  }
  return null
}
