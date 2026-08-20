import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../../legacy-core/utils/xshellQuickCommand.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const { parseXshellQbl, parseXshellQblDetailed, decodeQblText, parseXshellQblx } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)

const SAMPLE = [
  '[Info]',
  'Version=6.0',
  'Count=2',
  '[QuickButton]',
  'Button_1=显示文件\\n[1]ls -l',
  'Button_2=跳转目录\\n[1]cd /tmp',
].join('\r\n')

test('parseXshellQbl: 解析标准 [QuickButton] 节,按序号排序', () => {
  const cmds = parseXshellQbl(SAMPLE)
  assert.equal(cmds.length, 2)
  assert.deepEqual(cmds[0], { label: '显示文件', cmd: 'ls -l' })
  assert.deepEqual(cmds[1], { label: '跳转目录', cmd: 'cd /tmp' })
})

test('parseXshellQbl: 乱序 Button_N 按数字排序,忽略非 QuickButton 节', () => {
  const text = [
    '[Info]',
    'Button_9=不该收\\n[1]bad',
    '[QuickButton]',
    'Button_3=c\\n[1]three',
    'Button_1=a\\n[1]one',
    '[Other]',
    'Button_2=也不该收\\n[1]bad2',
  ].join('\n')
  const cmds = parseXshellQbl(text)
  assert.equal(cmds.length, 2)
  assert.equal(cmds[0].cmd, 'one')
  assert.equal(cmds[1].cmd, 'three')
})

test('parseXshellQbl: 多段 \\n[N] 拼成多行命令', () => {
  const cmds = parseXshellQbl('[QuickButton]\nButton_1=多行\\n[1]cd /var\\n[1]ls -l')
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].cmd, 'cd /var\nls -l')
})

test('parseXshellQbl: 空标签回退为命令前 20 字符;空命令条目跳过', () => {
  const cmds = parseXshellQbl('[QuickButton]\nButton_1=\\n[1]echo hello world this is long\nButton_2=只有标签')
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].label, 'echo hello world thi')
  assert.equal(cmds[0].cmd, 'echo hello world this is long')
})

test('parseXshellQbl: 无节头文件兜底收所有 Button_ 行;完全无 Button_ 返回空', () => {
  const loose = parseXshellQbl('Button_1=hi\\n[1]pwd')
  assert.equal(loose.length, 1)
  assert.equal(parseXshellQbl('[Info]\nVersion=6.0').length, 0)
  assert.equal(parseXshellQbl('not a qbl file').length, 0)
})

test('decodeQblText: UTF-8 优先,非法 UTF-8 回退 GBK', () => {
  const utf8 = new TextEncoder().encode('显示文件')
  assert.equal(decodeQblText(utf8.buffer), '显示文件')
  // '显' 的 GBK 编码 0xCF 0xD4 不是合法 UTF-8
  const gbk = Uint8Array.from([0xcf, 0xd4])
  assert.equal(decodeQblText(gbk.buffer), '显')
})

test('decodeQblText: UTF-16 LE/BE BOM 优先识别(Xshell 8 内层 commands.qbl)', () => {
  const text = '[Info]\r\nVersion=8.2\r\n'
  const le = Uint8Array.from([0xff, 0xfe, ...[...text].flatMap(c => [c.charCodeAt(0), 0])])
  assert.equal(decodeQblText(le), text)
  const be = Uint8Array.from([0xfe, 0xff, ...[...text].flatMap(c => [0, c.charCodeAt(0)])])
  assert.equal(decodeQblText(be), text)
})

test('parseXshellQblDetailed: 新版 Button_N_Name/Action 键格式,\\r\\n 转真实换行', () => {
  const text = [
    '[Info]',
    'Version=8.2',
    'Count=2',
    '[QuickButton]',
    'Button_0_Name=重启主控',
    'Button_0_Action=bash stopall.sh\\r\\nbash reader.sh\\r\\n',
    'Button_0_Type=1',
    'Button_1_Name=df',
    'Button_1_Action=df -h',
    'Button_1_Type=1',
  ].join('\r\n')
  const { commands, skippedScripts } = parseXshellQblDetailed(text)
  assert.equal(skippedScripts, 0)
  assert.deepEqual(commands, [
    { label: '重启主控', cmd: 'bash stopall.sh\nbash reader.sh' },
    { label: 'df', cmd: 'df -h' },
  ])
})

test('parseXshellQblDetailed: Type=2(本地脚本)跳过并计数;Windows 路径单反斜杠不误转义', () => {
  const text = [
    '[QuickButton]',
    'Button_0_Name=脚本',
    'Button_0_Action=D:\\Program Files\\xshell\\deploy.py',
    'Button_0_Type=2',
    'Button_1_Name=命令',
    'Button_1_Action=pwd\\r\\n',
    'Button_1_Type=1',
  ].join('\n')
  const { commands, skippedScripts } = parseXshellQblDetailed(text)
  assert.equal(skippedScripts, 1)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].label, '命令')
  assert.equal(commands[0].cmd, 'pwd')
})

// ── 手工拼一个最小 ZIP(deflate)验证 .qblx 解析 ──
function crc32(bytes) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      return c
    })
  }
  let crc = -1
  for (const b of bytes) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff]
  return (crc ^ -1) >>> 0
}

function utf16le(text) {
  const out = [0xff, 0xfe]
  for (const c of text) {
    const code = c.codePointAt(0)
    out.push(code & 0xff, code >> 8)
  }
  return Uint8Array.from(out)
}

async function buildZip(files) {
  // files: [{ name: string (gbk bytes via TextEncoder 只支持 utf8,这里用 ASCII/UTF8 名), data: Uint8Array }]
  const chunks = []
  const centrals = []
  let offset = 0
  const u16 = v => Uint8Array.of(v & 0xff, (v >> 8) & 0xff)
  const u32 = v => Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff)
  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name)
    const compressed = new Uint8Array(await new Response(
      new Blob([f.data]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    ).arrayBuffer())
    const crc = crc32(f.data)
    const local = [
      u32(0x04034b50), u16(20), u16(0x0800), u16(8), u16(0), u16(0),
      u32(crc), u32(compressed.length), u32(f.data.length),
      u16(nameBytes.length), u16(0), nameBytes, compressed,
    ]
    centrals.push({ nameBytes, crc, compressed, size: f.data.length, offset })
    for (const part of local) chunks.push(part)
    offset += local.reduce((n, p) => n + p.length, 0)
  }
  const cdStart = offset
  for (const c of centrals) {
    const parts = [
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(8), u16(0), u16(0),
      u32(c.crc), u32(c.compressed.length), u32(c.size),
      u16(c.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset),
      c.nameBytes,
    ]
    for (const part of parts) chunks.push(part)
    offset += parts.reduce((n, p) => n + p.length, 0)
  }
  chunks.push(u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(offset - cdStart), u32(cdStart), u16(0))
  const total = chunks.reduce((n, p) => n + p.length, 0)
  const zip = new Uint8Array(total)
  let at = 0
  for (const part of chunks) { zip.set(part, at); at += part.length }
  return zip.buffer
}

test('parseXshellQblx: 解 ZIP 多命令集,UTF-16 内层文件,多集加集名前缀,Type=2 跳过', async () => {
  const setA = utf16le('[Info]\r\nVersion=8.2\r\n[QuickButton]\r\nButton_0_Name=重启\r\nButton_0_Action=reboot\\r\\n\r\nButton_0_Type=1\r\n')
  const setB = utf16le('[Info]\r\nVersion=8.2\r\n[QuickButton]\r\nButton_0_Name=脚本\r\nButton_0_Action=D:\\x\\a.py\r\nButton_0_Type=2\r\nButton_1_Name=查看\r\nButton_1_Action=df -h\r\nButton_1_Type=1\r\n')
  const zip = await buildZip([
    { name: 'commands.qbl', data: utf16le('[Info]\r\nVersion=8.2\r\nCount=0\r\n') },
    { name: 'setA/commands.qbl', data: setA },
    { name: 'setB/commands.qbl', data: setB },
  ])
  const { commands, skippedScripts } = await parseXshellQblx(zip)
  assert.equal(skippedScripts, 1)
  assert.deepEqual(commands, [
    { label: 'setA/重启', cmd: 'reboot' },
    { label: 'setB/查看', cmd: 'df -h' },
  ])
})

test('parseXshellQblx: 单命令集不加前缀;非 ZIP 返回空', async () => {
  const zip = await buildZip([
    { name: 'only/commands.qbl', data: utf16le('[QuickButton]\r\nButton_0_Name=a\r\nButton_0_Action=pwd\r\nButton_0_Type=1\r\n') },
  ])
  const { commands } = await parseXshellQblx(zip)
  assert.deepEqual(commands, [{ label: 'a', cmd: 'pwd' }])
  const empty = await parseXshellQblx(new TextEncoder().encode('not a zip').buffer)
  assert.equal(empty.commands.length, 0)
})
