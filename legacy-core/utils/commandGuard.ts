/**
 * 命令风险检测(纯风险拦截,无白名单)
 *
 * 设计目标:
 *  - 风险词命中的命令:强制拦截,必须人工确认后才能执行
 *  - 未命中:放行(终端手动命令无需确认;AI 工具执行的审批由 dsh 审批门统一负责)
 *
 * 命令审批已整体移交 deepseek-harness 权限体系(设置 → 通用 → 权限),StarHub
 * 侧不再维护命令白名单;这里只保留系统级风险词,供 SSH 终端手动输入时拦截。
 */

export interface CommandCheckResult {
  /** 是否被风险词命中(命中后必须人工确认,不可绕过) */
  isRisky: boolean
  /** 命中的风险词(用于提示用户) */
  riskReason?: string
  /** 是否需要人工确认 */
  needsConfirm: boolean
  /** 用于确认对话框的展示文本 */
  confirmMessage: string
}

/**
 * 系统级风险词(硬编码,白名单无法绕过)
 *  - 正则匹配命令开头
 *  - 不区分大小写
 */
const RISKY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // 删库 / 删文件
  { pattern: /\brm\s+(-[a-z]*[rfRF]+|--force|--recursive)\b.*\/(?!\s*$)/i, reason: 'rm -rf 删除系统目录' },
  { pattern: /\brm\s+(-[a-z]*[rfRF]+|--force|--recursive)\b/i, reason: 'rm -rf 递归删除' },
  { pattern: /\brm\s+-[a-z]*r/i, reason: 'rm -r 递归删除' },
  { pattern: /\bdd\s+if=/i, reason: 'dd 命令会覆写磁盘' },
  { pattern: /\bmkfs\./i, reason: 'mkfs 格式化文件系统' },
  { pattern: /\b(format|fdisk)\b/i, reason: '磁盘格式化/分区工具' },
  { pattern: /\b(remove-item|ri)\b[^\n]*(-recurse|-force)/i, reason: 'PowerShell 递归/强制删除' },
  { pattern: /\b(del|erase)\b[^\n]*\/(s|q)\b/i, reason: 'Windows 批量/静默删除' },
  { pattern: /\b(rmdir|rd)\b[^\n]*\/s\b/i, reason: 'Windows 递归删除目录' },
  { pattern: /\b(format-volume|clear-disk|initialize-disk|diskpart)\b/i, reason: 'Windows 磁盘格式化/分区工具' },
  { pattern: /\bdiskutil\s+(erase|partition|apfs\s+delete)/i, reason: 'macOS 磁盘抹除/分区工具' },
  { pattern: /\bshutdown\b/i, reason: '关机命令' },
  { pattern: /\breboot\b/i, reason: '重启命令' },
  { pattern: /\bhalt\b/i, reason: '关机命令' },
  { pattern: /\bpoweroff\b/i, reason: '关机命令' },
  { pattern: /\b(stop-computer|restart-computer)\b/i, reason: 'Windows 关机/重启命令' },
  { pattern: /\bshutdown(?:\.exe)?\b[^\n]*\/(s|r|p)\b/i, reason: 'Windows 关机/重启命令' },
  { pattern: /\binit\s+[0-6]\b/i, reason: '切换运行级别' },
  { pattern: /\bkill\s+-9\s+1\b/i, reason: 'kill init 进程' },
  { pattern: /\bpkill\s+-9\s+-f\s+(bash|init|sshd)/i, reason: '杀死关键系统进程' },

  // 数据库 DROP / TRUNCATE
  { pattern: /\bdrop\s+(database|schema|table)\b/i, reason: 'DROP 数据库对象' },
  { pattern: /\btruncate\s+(table|only)\b/i, reason: 'TRUNCATE 清空表' },
  { pattern: /\bdelete\s+from\b.*\bwhere\s+1\s*=\s*1\b/i, reason: '无条件 DELETE' },
  { pattern: /\bdelete\s+from\b(?!\s+\S+\s*;?\s*$)/i, reason: 'DELETE 无 WHERE 子句' },  // 没 WHERE
  { pattern: /\bupdate\s+\S+\s+set\b(?![^;]*\bwhere\b)/i, reason: 'UPDATE 无 WHERE 子句' },
  { pattern: /\bgrant\s+all\b/i, reason: 'GRANT ALL 授权' },
  { pattern: /\brevoke\s+all\b/i, reason: 'REVOKE ALL 撤销授权' },

  // Docker 危险操作
  { pattern: /\bdocker\s+system\s+prune\s+-a/i, reason: 'docker system prune -a 删除所有未使用资源' },
  { pattern: /\bdocker\s+rm\s+-f\b/i, reason: 'docker rm -f 强制删除容器' },
  { pattern: /\bdocker\s+rmi\s+-f\b/i, reason: 'docker rmi -f 强制删除镜像' },
  { pattern: /\bdocker\s+volume\s+rm\b/i, reason: 'docker volume rm 删除数据卷' },
  { pattern: /\bdocker\s+network\s+rm\b/i, reason: 'docker network rm 删除网络' },
  { pattern: /\bdocker\s+exec\b.*\b(rm|mkfs|dd|shutdown|reboot)\b/i, reason: '容器内执行危险命令' },
  { pattern: /\bkubectl\s+delete\s+(namespace|node)\b/i, reason: 'kubectl 删除 namespace/node' },

  // 权限 / 提权
  { pattern: /\bchmod\s+(-[a-z]*[rR]+|--recursive)\b.*\b7{3,}\b/i, reason: 'chmod 777 公开权限' },
  { pattern: /\bchown\s+-R\b.*\b(root|0)\b/i, reason: 'chown 改属主为 root' },

  // 远程下载执行
  { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)\b/i, reason: '远程脚本管道执行' },
  { pattern: /\bwget\b.*\|\s*(bash|sh|zsh)\b/i, reason: '远程脚本管道执行' },
  { pattern: /\bcurl\b.*-o\s+\S+\s*&&\s*(chmod|xargs)/i, reason: '下载并执行文件' },

  // 防火墙 / 网络配置破坏
  { pattern: /\biptables\s+-F\b/i, reason: 'iptables 清空规则' },
  { pattern: /\bufw\s+(disable|reset)\b/i, reason: 'UFW 关闭/重置防火墙' },
]

/**
 * 检查命令是否命中系统级风险词。
 * 命中 → needsConfirm=true 且 mustConfirm(风险命令必须人工确认);未命中 → 放行。
 */
export function checkCommand(command: string): CommandCheckResult {
  const cmd = command.trim()

  // 风险词检测(系统级安全规则,不可绕过)
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        isRisky: true,
        riskReason: reason,
        needsConfirm: true,
        confirmMessage: `⚠️ 风险命令: ${reason}\n\n${cmd}\n\n此命令已被系统规则标记为高风险,必须人工确认后才能执行。`
      }
    }
  }

  return {
    isRisky: false,
    needsConfirm: false,
    confirmMessage: ''
  }
}

/**
 * 从终端回显行剥离 shell 提示符,提取命令文本。
 *
 * 从行首非贪婪匹配第一个提示符终止符($ / # / ❯ / % / ➜ / > / ])+空白,
 * 覆盖 bash / zsh / fish / PowerShell 等常见提示符;匹配不到时返回空串,
 * 调用方应回退到本地按键缓冲。
 */
export function stripShellPrompt(line: string): string {
  const m = line.trim().match(/^.*?[$#❯%➜>\]]\s+(.*)$/)
  return (m?.[1] ?? '').trim()
}

/**
 * 等待用户确认异常 — AI 工具执行器在需要用户批准时 throw 这个,
 * AiChat 接到 awaiting-confirm 状态后 emit confirm-tool 事件,父组件
 * 调用 resolve() 推进执行。
 */
export class PendingConfirmError extends Error {
  readonly callId: string
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly message: string
  resolve: (approved: boolean) => void

  constructor(opts: {
    callId: string
    toolName: string
    args: Record<string, unknown>
    message: string
  }) {
    super(opts.message)
    this.callId = opts.callId
    this.toolName = opts.toolName
    this.args = opts.args
    this.message = opts.message
    this.resolve = () => { /* noop, set by executeTool */ }
  }
}

// ── 只读判定:Agent「自动批准(仅查询)」的安全边界 ──
// 设计原则:宁可误拦(退回人工确认)也不误放,任何不确定的形态一律返回 false。

/** 语句级写关键字:出现在语句里即视为非只读(覆盖 WITH CTE 里藏 UPDATE 等情况) */
const SQL_WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|call|use|lock|unlock|rename|set)\b/i
const SQL_READ_START = /^(select|show|desc|describe|explain)\b/i

/**
 * 只读 SQL 判定:去掉注释后,每条语句都以 SELECT/SHOW/DESC/DESCRIBE/EXPLAIN 开头
 * (或 WITH 开头的 CTE 且全文不含写关键字),且全文不含写关键字。
 */
export function isReadOnlySql(sql: string): boolean {
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const statements = cleaned.split(';').map(s => s.trim()).filter(s => s.length > 0)
  if (statements.length === 0) return false
  return statements.every(s => {
    if (SQL_WRITE_KEYWORDS.test(s)) return false
    if (SQL_READ_START.test(s)) return true
    return /^with\b/i.test(s) && !SQL_WRITE_KEYWORDS.test(s)
  })
}

/** 只读 Shell 单条命令前缀(首 token 或小分子命令) */
const READ_ONLY_SHELL_SINGLE = new Set([
  'ls', 'll', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file',
  'find', 'grep', 'egrep', 'fgrep', 'rg', 'ps', 'top', 'htop', 'uptime', 'free',
  'df', 'du', 'mount', 'lsblk', 'lsof', 'uname', 'hostname', 'date', 'whoami',
  'id', 'w', 'who', 'last', 'env', 'printenv', 'which', 'whereis', 'type',
  'echo', 'printf', 'ip', 'ifconfig', 'netstat', 'ss', 'ping', 'traceroute',
  'dig', 'nslookup', 'host', 'journalctl', 'getenforce', 'lsusb', 'lspci',
  'vmstat', 'iostat', 'nproc', 'lsmod', 'dmesg', 'lsattr', 'getfacl', 'tree',
])
const READ_ONLY_SHELL_PAIRS = new Set([
  'docker ps', 'docker images', 'docker logs', 'docker inspect', 'docker stats',
  'docker top', 'docker version', 'docker info', 'docker port',
  'kubectl get', 'kubectl describe', 'kubectl logs', 'kubectl version',
  'kubectl api-resources', 'systemctl status', 'systemctl list-units',
  'systemctl list-timers', 'systemctl show', 'service --status-all',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
  'redis-cli get', 'redis-cli mget', 'redis-cli keys', 'redis-cli scan',
  'redis-cli ttl', 'redis-cli type', 'redis-cli exists', 'redis-cli info',
  'redis-cli hget', 'redis-cli hgetall', 'redis-cli lrange', 'redis-cli smembers',
  'redis-cli zrange', 'redis-cli dbsize', 'redis-cli ping',
])

/**
 * 只读 Shell 判定:按 && / || / | / ; 切段,每段都必须满足:
 *  - 无重定向(> >>)与命令替换($( )、反引号)
 *  - 不是 sudo / su 提权
 *  - 首 token(或 docker ps 这类两段子命令)在只读清单内
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const segments = command.split(/&&|\|\||[|;]/).map(s => s.trim()).filter(s => s.length > 0)
  if (segments.length === 0) return false
  return segments.every(seg => {
    if (/[>`]|\$\(|`/.test(seg)) return false
    const parts = seg.split(/\s+/)
    const first = parts[0]?.toLowerCase()
    if (!first || first === 'sudo' || first === 'su') return false
    if (READ_ONLY_SHELL_SINGLE.has(first)) return true
    if (parts.length >= 2 && READ_ONLY_SHELL_PAIRS.has(`${first} ${parts[1].toLowerCase()}`)) return true
    return false
  })
}

/**
 * 只读工具调用判定(供 Agent 自动批准):
 *  - 带 sql 参数的走 isReadOnlySql
 *  - 带 command 参数的走 isReadOnlyShellCommand
 *  - 其他形态(MCP、文件写入、无命令文本)一律不放行
 */
export function isReadOnlyToolCall(toolName: string, args: Record<string, unknown>): boolean {
  const sql = typeof args.sql === 'string' ? args.sql : ''
  if (sql) return isReadOnlySql(sql)
  const command = typeof args.command === 'string' ? args.command : ''
  if (command) return isReadOnlyShellCommand(command)
  return false
}
