/**
 * 会话工作区 git 服务(2026-08-21,会话头部「分支胶囊」的数据层):
 * 全部经 Tauri `local_shell_exec` 在会话 cwd 下跑固定形式的 git 子命令;
 * 浏览器预览(无 Tauri IPC)调用方先行隐藏,这里只做薄封装。
 *
 * 安全面:命令形状固定,唯一插值是分支名(来自 git 自身输出)与提交信息
 * (PowerShell 单引号转义);不提供任意命令入口。
 */
import { tauriInvoke } from '../tauri.ts'

/** `local_shell_exec` 的返回(serde camelCase)。 */
export interface LocalShellResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly elapsedMs: number
  readonly truncated: boolean
}

/** 一次 git 操作的简化结果。 */
export interface GitOutcome {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

/** PowerShell 单引号字符串转义(单引号翻倍)。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 在工作区目录执行一条固定形状的 git 命令。
 * @param cwd - 会话工作区绝对路径。
 * @param command - 完整 git 命令行(内部组装,不接受用户输入直拼)。
 * @param timeoutSec - 超时秒数(push 等网络操作给 120)。
 * @returns 简化结果;IPC/进程级失败转为 ok:false。
 */
async function runGit(cwd: string, command: string, timeoutSec?: number): Promise<GitOutcome> {
  try {
    const result = await tauriInvoke<LocalShellResult>('local_shell_exec', {
      command,
      workingDir: cwd,
      ...(timeoutSec === undefined ? {} : { timeoutSec }),
    })
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    }
  } catch (error) {
    return { ok: false, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读当前分支名;detached HEAD 返回 `( detached <短sha> )`,非 git 仓库返回 null。
 * @param cwd - 会话工作区绝对路径。
 * @returns 分支展示名;非仓库/IPC 不可用返回 null。
 */
export async function gitCurrentBranch(cwd: string): Promise<string | null> {
  const branch = await runGit(cwd, 'git branch --show-current')
  if (branch.ok && branch.stdout !== '') return branch.stdout
  const head = await runGit(cwd, 'git rev-parse --short HEAD')
  if (head.ok && head.stdout !== '') return `(detached ${head.stdout})`
  return null
}

/**
 * 列本地分支名(当前分支除外不特殊标注,由调用方对照)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 分支名列表;失败返回空数组。
 */
export async function gitListBranches(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, 'git branch "--format=%(refname:short)"')
  if (!result.ok) return []
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * 工作区是否有未提交改动(切换分支前的提示依据)。
 * @param cwd - 会话工作区绝对路径。
 * @returns true = 有改动;命令失败按 false 处理(不阻塞操作)。
 */
export async function gitIsDirty(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, 'git status --porcelain')
  return result.ok && result.stdout !== ''
}

/**
 * 切换分支。
 * @param cwd - 会话工作区绝对路径。
 * @param branch - 目标分支名(来自 gitListBranches,不做任意输入)。
 * @returns 简化结果。
 */
export function gitCheckout(cwd: string, branch: string): Promise<GitOutcome> {
  return runGit(cwd, `git checkout ${psQuote(branch)}`)
}

/**
 * 暂存全部改动并提交(git add -A && git commit)。
 * @param cwd - 会话工作区绝对路径。
 * @param message - 提交信息(PowerShell 单引号转义)。
 * @returns 简化结果。
 */
export async function gitCommitAll(cwd: string, message: string): Promise<GitOutcome> {
  const add = await runGit(cwd, 'git add -A')
  if (!add.ok) return add
  return runGit(cwd, `git commit -m ${psQuote(message)}`)
}

/**
 * 推送当前分支(git push,网络操作超时 120s)。
 * @param cwd - 会话工作区绝对路径。
 * @returns 简化结果。
 */
export function gitPush(cwd: string): Promise<GitOutcome> {
  return runGit(cwd, 'git push', 120)
}
