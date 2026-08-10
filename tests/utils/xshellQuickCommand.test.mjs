import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../../src/utils/xshellQuickCommand.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const { parseXshellQbl, decodeQblText } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)

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
