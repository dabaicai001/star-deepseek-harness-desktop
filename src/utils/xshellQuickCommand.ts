/**
 * Xshell 快速命令集(.qbl)解析。
 *
 * .qbl 是 INI 风格的文本文件,结构示例:
 *   [Info]
 *   Version=6.0
 *   Count=2
 *   [QuickButton]
 *   Button_1=显示文件\n[1]ls -l
 *   Button_2=跳转目录\n[1]cd /tmp
 *
 * 每条 Button_N 的值 = 按钮标签 + 字面量 "\n[N]" 分隔符 + 要发送的命令。
 * 分隔符中的数字是 Xshell 的动作类型标记(1=发送字符串),导入时只取文本内容。
 * 同一按钮出现多段 "\n[N]xxx" 时按多行命令处理,以真实换行连接。
 * 纯函数,node --test 可测。
 */
export interface XshellQuickCommand {
  label: string
  cmd: string
}

/** 分隔符:字面量反斜杠+n+[数字],如 "\n[1]" */
const SEGMENT_SEP = /\\n\[\d+\]/

/**
 * 解析 .qbl 文本,返回按 Button_N 序号排序的快捷命令列表。
 * 无法识别任何 Button_ 条目时返回空数组。
 */
export function parseXshellQbl(text: string): XshellQuickCommand[] {
  const buttons: { index: number; label: string; cmd: string }[] = []
  let inQuickButton = false
  let sawSection = false

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      sawSection = true
      inQuickButton = section[1].trim().toLowerCase() === 'quickbutton'
      continue
    }
    const m = /^Button_(\d+)\s*=\s*(.*)$/i.exec(line)
    // 文件里出现过节头时只认 [QuickButton] 节;完全没有节头的文件兜底全收
    if (!m || (sawSection && !inQuickButton)) continue

    const segments = m[2].split(SEGMENT_SEP)
    const label = segments[0].trim()
    const cmd = segments.slice(1).join('\n').trim()
    if (!cmd) continue
    buttons.push({ index: Number(m[1]), label: label || cmd.slice(0, 20), cmd })
  }

  return buttons
    .sort((a, b) => a.index - b.index)
    .map(({ label, cmd }) => ({ label, cmd }))
}

/**
 * 解码 .qbl 文件内容:Xshell 在中文 Windows 上可能导出 GBK 编码,
 * 先按 UTF-8 严格解码,失败则回退 GBK。
 */
export function decodeQblText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('gbk').decode(buf)
  }
}
