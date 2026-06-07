/**
 * 命令风险检测 + 白名单匹配
 *
 * 设计目标:
 *  - 风险词命中的命令:无论白名单如何,必须弹确认对话框
 *  - 白名单命中的命令:免确认直接执行
 *  - 都不命中:弹确认(默认行为)
 *
 * 风险词是写死的系统级安全规则,白名单可由用户在 Settings → AI 配置。
 */

export interface CommandCheckResult {
  /** 是否被风险词命中(命中后必须确认,不能加白名单绕过) */
  isRisky: boolean
  /** 命中的风险词(用于提示用户) */
  riskReason?: string
  /** 是否在白名单(免确认) */
  isWhitelisted: boolean
  /** 是否需要弹确认对话框 */
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
  { pattern: /\bshutdown\b/i, reason: '关机命令' },
  { pattern: /\breboot\b/i, reason: '重启命令' },
  { pattern: /\bhalt\b/i, reason: '关机命令' },
  { pattern: /\bpoweroff\b/i, reason: '关机命令' },
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
 * 检查命令,返回拦截结果
 */
export function checkCommand(
  command: string,
  whitelist: string[]
): CommandCheckResult {
  const cmd = command.trim()

  // 1. 风险词检测(优先级最高)
  for (const { pattern, reason } of RISKY_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        isRisky: true,
        riskReason: reason,
        isWhitelisted: false,
        needsConfirm: true,
        confirmMessage: `⚠️ 风险命令: ${reason}\n\n${cmd}\n\n此命令已被系统规则标记为高风险,白名单无法绕过,必须人工确认。`
      }
    }
  }

  // 2. 白名单匹配(前缀匹配)
  for (const prefix of whitelist) {
    if (matchesWhitelist(cmd, prefix)) {
      return {
        isRisky: false,
        isWhitelisted: true,
        needsConfirm: false,
        confirmMessage: ''
      }
    }
  }

  // 3. 都不命中:弹确认(默认行为)
  return {
    isRisky: false,
    isWhitelisted: false,
    needsConfirm: true,
    confirmMessage: `即将执行命令:\n\n${cmd}\n\n请确认是否执行。`
  }
}

/**
 * 白名单前缀匹配:支持简单的开头匹配,自动 trim 空白
 */
function matchesWhitelist(command: string, prefix: string): boolean {
  const p = prefix.trim()
  if (!p) return false
  // 完整命令以 p 开头(允许前导空格)
  if (command.startsWith(p)) return true
  // 允许 "ls" 匹配 "ls -la"(任意 ls 开头的命令)
  if (command.startsWith(p + ' ')) return true
  return false
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

/**
 * 从命令中提取白名单前缀
 * 例如: "rm -rf /tmp" → "rm"
 *       "docker ps -a" → "docker ps"
 *       "ls -la /home" → "ls"
 */
export function extractWhitelistPrefix(command: string): string {
  const cmd = command.trim()
  if (!cmd) return ''

  // 分割命令参数
  const parts = cmd.split(/\s+/)
  if (parts.length === 0) return ''

  // 对于 docker/kubectl 等子命令，取前两段
  const multiWordCommands = ['docker', 'kubectl', 'systemctl', 'journalctl', 'git', 'mysql', 'redis-cli']
  if (multiWordCommands.includes(parts[0]) && parts.length >= 2) {
    return `${parts[0]} ${parts[1]}`
  }

  // 其他命令取第一段
  return parts[0]
}
