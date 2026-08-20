import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../legacy-core/utils/terminalCwd.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const mod = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { extractOsc7Cwd, OSC7_INJECT_COMMAND, parsePwdOutput } = mod

test('extractOsc7Cwd: 解析裸路径形式(BEL 结尾)', () => {
  const { cwd, rest } = extractOsc7Cwd('prompt$ \x1b]7;/root\x07')
  assert.equal(cwd, '/root')
  // rest 只保留最后一个完整匹配之后的未消费尾部
  assert.equal(rest, '')
})

test('extractOsc7Cwd: 解析标准 file://host/path 形式(ST 结尾)', () => {
  const { cwd } = extractOsc7Cwd('\x1b]7;file://myhost/etc/nginx\x1b\\')
  assert.equal(cwd, '/etc/nginx')
})

test('extractOsc7Cwd: 多个上报取最新一个', () => {
  const { cwd } = extractOsc7Cwd('\x1b]7;/root\x07\x1b]7;/tmp\x07')
  assert.equal(cwd, '/tmp')
})

test('extractOsc7Cwd: 跨分片的序列保留未消费尾部', () => {
  const first = extractOsc7Cwd('noise\x1b]7;/va')
  assert.equal(first.cwd, null)
  const second = extractOsc7Cwd(first.rest + 'r/log\x07')
  assert.equal(second.cwd, '/var/log')
})

test('extractOsc7Cwd: 非绝对路径不上报', () => {
  const { cwd } = extractOsc7Cwd('\x1b]7;relative/dir\x07')
  assert.equal(cwd, null)
})

test('OSC7_INJECT_COMMAND: bash/zsh 通用且不写远端配置文件', () => {
  assert.ok(OSC7_INJECT_COMMAND.endsWith('\n'))
  assert.ok(OSC7_INJECT_COMMAND.includes('PROMPT_COMMAND'))
  assert.ok(OSC7_INJECT_COMMAND.includes('precmd_functions'))
  assert.ok(OSC7_INJECT_COMMAND.includes('\\033]7;'))
  assert.ok(!OSC7_INJECT_COMMAND.includes('.bashrc'))
})

test('parsePwdOutput: 取第一个绝对路径行', () => {
  assert.equal(parsePwdOutput('/root\n'), '/root')
  assert.equal(parsePwdOutput('banner\r\n/home/user\r\n'), '/home/user')
  assert.equal(parsePwdOutput('no path here'), null)
})
