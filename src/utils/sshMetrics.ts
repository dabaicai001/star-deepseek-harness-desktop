/**
 * 解析 SSH 远程跑命令的输出,转成仪表盘需要的结构化数据。
 * 所有数据都来自真实 SSH exec,无任何 mock。
 */

/** /proc/meminfo 解析后的内存指标(单位:字节) */
export interface SshMemInfo {
  total: number
  free: number
  available: number
  buffers: number
  cached: number
  swapTotal: number
  swapFree: number
}

/** /proc/loadavg + nproc */
export interface SshLoadInfo {
  load1: number
  load5: number
  load15: number
  cpuCores: number
}

/** `df -P -B1 /` 解析后的磁盘指标(单位:字节) */
export interface SshDiskInfo {
  total: number
  used: number
  free: number
  mountpoint: string
  /** 从 `df -P -B1 /data /var` 这种多行取,取使用率最大的 */
  entries: { mountpoint: string; total: number; used: number; free: number }[]
}

/** `uname -a` + `hostname` */
export interface SshSystemInfo {
  hostname: string
  kernel: string
  arch: string
  osPretty: string
}

/** `uptime -p` 或 `cat /proc/uptime` 解析后的运行时间(秒) */
export interface SshUptimeInfo {
  seconds: number
  pretty: string
}

/** 解析 /proc/meminfo 文本输出 */
export function parseMemInfo(text: string): SshMemInfo {
  const get = (key: string): number => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
    return m ? parseInt(m[1], 10) * 1024 : 0
  }
  return {
    total: get('MemTotal'),
    free: get('MemFree'),
    available: get('MemAvailable'),
    buffers: get('Buffers'),
    cached: get('Cached'),
    swapTotal: get('SwapTotal'),
    swapFree: get('SwapFree'),
  }
}

/** 解析 `cat /proc/loadavg` 输出 + `nproc` */
export function parseLoad(loadavgText: string, nprocText: string): SshLoadInfo {
  const parts = loadavgText.trim().split(/\s+/)
  const cpuCores = parseInt(nprocText.trim(), 10) || 1
  return {
    load1: parseFloat(parts[0] || '0') || 0,
    load5: parseFloat(parts[1] || '0') || 0,
    load15: parseFloat(parts[2] || '0') || 0,
    cpuCores,
  }
}

/** 解析 `df -P -B1` 的输出(以字节为单位,POSIX 格式稳定可解析) */
export function parseDf(text: string): SshDiskInfo {
  const lines = text.trim().split('\n')
  const entries: SshDiskInfo['entries'] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/)
    if (cols.length < 6) continue
    const filesystem = cols[0]
    // 过滤 tmpfs / devtmpfs / overlay 等伪文件系统
    if (/^(tmpfs|devtmpfs|overlay|proc|sysfs|udev)$/i.test(filesystem)) continue
    const total = parseInt(cols[1], 10) || 0
    const used = parseInt(cols[2], 10) || 0
    const free = parseInt(cols[3], 10) || 0
    const mountpoint = cols[5]
    if (total === 0) continue
    entries.push({ mountpoint, total, used, free })
  }
  // 取使用率最高的挂载点作为主显示
  if (entries.length === 0) {
    return { total: 0, used: 0, free: 0, mountpoint: '/', entries: [] }
  }
  entries.sort((a, b) => b.used / b.total - a.used / a.total)
  const top = entries[0]
  return {
    total: top.total,
    used: top.used,
    free: top.free,
    mountpoint: top.mountpoint,
    entries,
  }
}

/** 解析 `uname -a` + `hostname` 输出 */
export function parseSystemInfo(unameText: string, hostnameText: string): SshSystemInfo {
  const hostname = hostnameText.trim() || '--'
  const parts = unameText.trim().split(/\s+/)
  // uname -a 输出: Linux hostname kernel-version #1 SMP ... x86_64 GNU/Linux
  const kernel = parts[2] || '--'
  const arch = parts.find(p => /^(x86_64|aarch64|armv7l|i686|arm64)$/.test(p)) || parts[parts.length - 2] || '--'
  return {
    hostname,
    kernel,
    arch,
    osPretty: kernel,
  }
}

/** 解析 `cat /proc/uptime`(秒,小数) + 转可读格式 */
export function parseUptime(text: string): SshUptimeInfo {
  const seconds = Math.floor(parseFloat(text.trim().split(/\s+/)[0] || '0') || 0)
  return { seconds, pretty: formatUptime(seconds) }
}

/** 秒数 → "X天 Y小时 Z分钟" */
export function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '--'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${mins}分钟`
  return `${mins}分钟`
}

/** 字节 → 可读格式 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}
