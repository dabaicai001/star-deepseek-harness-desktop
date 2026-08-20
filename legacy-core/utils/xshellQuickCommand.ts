/**
 * Xshell 快速命令集(.qbl / .qblx)解析。
 *
 * .qbl 是 INI 风格文本,有两种键格式:
 *
 * 旧版(Version=6.x,UTF-8/GBK):
 *   [QuickButton]
 *   Button_1=显示文件\n[1]ls -l        ← 标签 + 字面量 "\n[N]" + 命令
 *
 * 新版(Version=8.x,UTF-16 LE 带 BOM,.qblx 内层文件):
 *   [QuickButton]
 *   Button_0_Name=重启设备
 *   Button_0_Action=/etc/init.d/networking restart\r\n   ← 字面量 "\r\n" 表换行
 *   Button_0_Type=1                    ← 1=发送文本;2=运行本地脚本(导入时跳过)
 *
 * .qblx 是 ZIP 包:每个命令集一个目录(目录名可能 GBK 编码),
 * 各含一个 commands.qbl;根目录还有一个默认集的 commands.qbl。
 * 全部函数无 DOM 依赖,node --test 可测。
 */
export interface XshellQuickCommand {
  label: string
  cmd: string
}

export interface XshellParseResult {
  commands: XshellQuickCommand[]
  /** 被跳过的条目数(Type=2 运行本地脚本,对 StarHub 无意义) */
  skippedScripts: number
}

/** 旧版分隔符:字面量反斜杠+n+[数字],如 "\n[1]" */
const SEGMENT_SEP = /\\n\[\d+\]/

/** 新版键:Button_<序号>_<字段> */
const KEYED_RE = /^Button_(\d+)_(Name|Action|Type|Desc|Icon|Param)\s*=\s*(.*)$/i
/** 旧版键:Button_<序号>=标签\n[N]命令 */
const LEGACY_RE = /^Button_(\d+)\s*=\s*(.*)$/i

/** 新版 Action 里的字面量转义换行:"\r\n" / "\n" / "\r" → 真实换行。
 * 只匹配反斜杠紧跟 r/n 的两字符序列,Windows 路径里的单个反斜杠不受影响。 */
function unescapeNewlines(text: string): string {
  return text.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\n+$/g, '').trim()
}

/**
 * 解析 .qbl 文本(新旧两种键格式都支持),返回按序号排序的命令列表
 * 及跳过的脚本条目数。无法识别任何 Button_ 条目时返回空。
 */
export function parseXshellQblDetailed(text: string): XshellParseResult {
  const legacy: { index: number; label: string; cmd: string }[] = []
  const keyed = new Map<number, { name?: string; action?: string; type?: string }>()
  let skippedScripts = 0
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
    // 文件里出现过节头时只认 [QuickButton] 节;完全没有节头的文件兜底全收
    if (sawSection && !inQuickButton) continue

    const keyedMatch = KEYED_RE.exec(line)
    if (keyedMatch) {
      const index = Number(keyedMatch[1])
      const field = keyedMatch[2].toLowerCase()
      const entry = keyed.get(index) ?? {}
      if (field === 'name') entry.name = keyedMatch[3]
      else if (field === 'action') entry.action = keyedMatch[3]
      else if (field === 'type') entry.type = keyedMatch[3]
      keyed.set(index, entry)
      continue
    }

    const legacyMatch = LEGACY_RE.exec(line)
    if (!legacyMatch) continue
    const segments = legacyMatch[2].split(SEGMENT_SEP)
    const label = segments[0].trim()
    const cmd = segments.slice(1).join('\n').trim()
    if (!cmd) continue
    legacy.push({ index: Number(legacyMatch[1]), label: label || cmd.slice(0, 20), cmd })
  }

  const keyedCommands: { index: number; label: string; cmd: string }[] = []
  for (const [index, entry] of keyed) {
    const cmd = entry.action ? unescapeNewlines(entry.action) : ''
    if (!cmd) continue
    if (entry.type === '2') { skippedScripts++; continue }
    const label = (entry.name ?? '').trim()
    keyedCommands.push({ index, label: label || cmd.slice(0, 20), cmd })
  }

  const commands = [...legacy, ...keyedCommands]
    .sort((a, b) => a.index - b.index)
    .map(({ label, cmd }) => ({ label, cmd }))
  return { commands, skippedScripts }
}

/** 解析 .qbl 文本,只返回命令列表(兼容旧调用方) */
export function parseXshellQbl(text: string): XshellQuickCommand[] {
  return parseXshellQblDetailed(text).commands
}

/**
 * 解码 .qbl 文件内容。
 * Xshell 8 导出的内层 commands.qbl 是 UTF-16(带 BOM);
 * 老版本在中文 Windows 上可能是 GBK —— BOM 优先,其次 UTF-8 严格解码,
 * 失败回退 GBK。
 */
export function decodeQblText(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gbk').decode(bytes)
  }
}

// ── .qblx(ZIP)解析:手工读中央目录 + DecompressionStream 解压,零依赖 ──

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP_UTF8_FLAG = 0x0800

function findZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 从尾部找 EOCD(最多回扫 64KB 注释区)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) return []

  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) break
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLen)
    const name = flags & ZIP_UTF8_FLAG
      ? new TextDecoder('utf-8').decode(nameBytes)
      : new TextDecoder('gbk').decode(nameBytes)
    entries.push({ name, method, compressedSize, localHeaderOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = entry.localHeaderOffset
  if (view.getUint32(at, true) !== LOCAL_SIG) return new Uint8Array(0)
  const nameLen = view.getUint16(at + 26, true)
  const extraLen = view.getUint16(at + 28, true)
  const start = at + 30 + nameLen + extraLen
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRaw(data)
  return new Uint8Array(0)
}

/**
 * 解析 .qblx(ZIP):读取所有 `<命令集>/commands.qbl`(含根目录默认集),
 * 合并全部命令。多个非空命令集时标签加 `集名/` 前缀区分来源。
 * 非 ZIP 或没有任何 commands.qbl 时返回空结果。
 */
export async function parseXshellQblx(buf: ArrayBuffer): Promise<XshellParseResult> {
  const bytes = new Uint8Array(buf)
  const entries = findZipEntries(bytes).filter(e =>
    /(^|\/)commands\.qbl$/i.test(e.name.replace(/\\/g, '/'))
  )
  if (entries.length === 0) return { commands: [], skippedScripts: 0 }

  const sets: { setName: string; result: XshellParseResult }[] = []
  for (const entry of entries) {
    const data = await readZipEntry(bytes, entry)
    if (data.length === 0) continue
    const result = parseXshellQblDetailed(decodeQblText(data))
    const normalized = entry.name.replace(/\\/g, '/')
    const setName = normalized.includes('/')
      ? normalized.slice(0, normalized.lastIndexOf('/'))
      : ''
    sets.push({ setName, result })
  }

  const nonEmpty = sets.filter(s => s.result.commands.length > 0)
  const multiSet = nonEmpty.length > 1
  const commands: XshellQuickCommand[] = []
  let skippedScripts = 0
  for (const { setName, result } of sets) {
    skippedScripts += result.skippedScripts
    for (const cmd of result.commands) {
      commands.push(multiSet && setName ? { label: `${setName}/${cmd.label}`, cmd: cmd.cmd } : cmd)
    }
  }
  return { commands, skippedScripts }
}
