/**
 * SSH AI 后台任务工具
 *
 * 背景:AI 助手经常发出容易阻塞的命令(如 `sleep 50; if ...` 轮询脚本),
 * PTY 路径 60s 后会被 Ctrl+C 打断,静默路径 120s 后超时,导致工作流假死。
 *
 * 这里的方案是「脚本落盘 + nohup 后台跑 + 轮询工具内部带 sleep」:
 *  - ssh_exec_background:把命令 base64 落盘成 run.sh,nohup 后台执行,
 *    stdout/stderr 写 out.log,退出码写 exit 文件,立即返回 task_id
 *  - ssh_wait_task:在远端用 1s 粒度循环最多等 wait_seconds,
 *    返回 [STATUS] RUNNING/FINISHED + 日志尾部,sleep 只发生在这条命令里
 *
 * 全部为纯函数,便于 node --test 直接测。
 */

/** 远端任务目录根(每个任务一个子目录:run.sh / out.log / exit / pid) */
export const AI_BG_TASK_ROOT = '/tmp/starhub-ai-bg'

/** ssh_wait_task 单次最多等待秒数(留足 ssh_exec 120s 超时的余量) */
export const AI_BG_MAX_WAIT_S = 55

/** 轮询返回的日志尾部字节数 */
export const AI_BG_LOG_TAIL_BYTES = 4000

/** 生成一个任务 id(只含安全字符,可直接拼进路径) */
export function newBackgroundTaskId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `task-${Date.now().toString(36)}-${rand}`
}

/** task_id 来自 LLM,必须严格校验后再拼进 shell,防注入 */
export function isValidTaskId(taskId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(taskId)
}

/** 把 wait_seconds 参数收敛到 [1, AI_BG_MAX_WAIT_S],非法值回退 30 */
export function clampTaskWaitSeconds(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 30
  return Math.min(AI_BG_MAX_WAIT_S, Math.max(1, Math.floor(n)))
}

/** shell 单引号安全转义 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** UTF-8 安全的 base64(脚本里可能有中文,btoa 不能直接吃非 Latin1) */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * 构造后台启动命令:
 *  1. 建任务目录,把命令 base64 落盘成 run.sh(避免多层引号转义问题)
 *  2. nohup 后台跑 run.sh,输出进 out.log,退出码写 exit 文件,pid 写 pid 文件
 *  3. 立即打印 [TASK] <id> STARTED PID=<pid> 返回
 * 整条命令本身瞬间结束,不会阻塞终端。
 */
export function buildBackgroundStartCommand(command: string, taskId: string): string {
  const dir = `${AI_BG_TASK_ROOT}/${taskId}`
  const b64 = toBase64(command)
  return [
    `d=${shellQuote(dir)}`,
    `mkdir -p "$d"`,
    `printf '%s' ${shellQuote(b64)} | base64 -d > "$d/run.sh"`,
    `chmod +x "$d/run.sh"`,
    `{ nohup bash -c 'bash "$1" > "$2" 2>&1; echo $? > "$3"' _ "$d/run.sh" "$d/out.log" "$d/exit" >/dev/null 2>&1 & echo $! > "$d/pid"; }`,
    `echo "[TASK] ${taskId} STARTED PID=$(cat "$d/pid")"`
  ].join(' && ')
}

/**
 * 构造任务轮询命令(由 ssh_wait_task 经静默 exec channel 执行,不占用用户终端):
 * 以 1s 为粒度最多等 waitSeconds 秒,exit 文件出现即提前结束;
 * 输出 [STATUS] FINISHED EXIT=<码> / RUNNING PID=<pid> / NOT_FOUND,再附日志尾部。
 */
export function buildTaskPollCommand(taskId: string, waitSeconds: number): string {
  const dir = `${AI_BG_TASK_ROOT}/${taskId}`
  const w = clampTaskWaitSeconds(waitSeconds)
  return `d=${shellQuote(dir)}; if [ ! -d "$d" ]; then echo "[STATUS] NOT_FOUND"; exit 1; fi; i=0; while [ "$i" -lt ${w} ] && [ ! -f "$d/exit" ]; do sleep 1; i=$((i+1)); done; if [ -f "$d/exit" ]; then echo "[STATUS] FINISHED EXIT=$(cat "$d/exit" 2>/dev/null)"; else echo "[STATUS] RUNNING PID=$(cat "$d/pid" 2>/dev/null)"; fi; echo "[LOG TAIL]"; tail -c ${AI_BG_LOG_TAIL_BYTES} "$d/out.log" 2>/dev/null`
}

/**
 * 检测命令里是否包含长时间 sleep(默认阈值 15s,支持 s/m/h 后缀)。
 * 命中时前台工具应拒绝并引导改用 ssh_exec_background,返回等待秒数。
 */
export function findLongSleepSeconds(command: string, thresholdSec = 15): number | null {
  const re = /\bsleep\s+(\d+(?:\.\d+)?)([smh]?)\b/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(command)) !== null) {
    const value = Number.parseFloat(match[1])
    const unit = match[2].toLowerCase()
    const seconds = unit === 'm' ? value * 60 : unit === 'h' ? value * 3600 : value
    if (seconds >= thresholdSec) return seconds
  }
  return null
}
