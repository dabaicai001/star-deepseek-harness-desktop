import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../src/utils/sshPromptCapture.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const mod = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { hasReturnedPrompt, cleanPromptCapturedOutput, isCommandEchoFragment, isShellPromptLine } = mod

const PROMPT = 'root@autodl-container-06c7:~#'
const COMMAND =
  'sleep 5; ps -p 2128 -o pid,etime,cmd 2>/dev/null; echo "---log tail---";' +
  ' tail -20 /root/autodl-tmp/hfd_logs/download.log 2>/dev/null; echo "---stdout tail---";' +
  ' tail -10 /root/autodl-tmp/hfd_logs/stdout.log 2>/dev/null'

test('sleep 期间折行回显的尾部片段不能被误判成 prompt 返回', () => {
  // 终端宽度折行后,命令回显的最后一行片段形如 "路径 ... 2>",外形像 prompt
  const echoedDuringSleep =
    `${PROMPT} sleep 5; ps -p 2128 -o pid,etime,cmd 2>/dev/null; echo "---log tail---";\r\n` +
    ` tail -20 /root/autodl-tmp/hfd_logs/download.log 2>/dev/null; echo "---stdout tail---";\r\n` +
    ` tail -10 /root/autodl-tmp/hfd_logs/stdout.log 2>\r\n`
  assert.equal(hasReturnedPrompt(echoedDuringSleep, PROMPT, COMMAND), false)
})

test('命令执行完毕、prompt 重新出现时返回 true', () => {
  const done =
    `${PROMPT} sleep 5; ps -p 2128 -o pid,etime,cmd 2>/dev/null\r\n` +
    ` 2128    01:23 hfd\r\n` +
    `---log tail---\r\n` +
    `downloaded 10/12\r\n` +
    `${PROMPT} `
  assert.equal(hasReturnedPrompt(done, PROMPT, COMMAND.split(';')[0]), true)
})

test('expectedPrompt 缺失时通用 prompt 模式仍生效', () => {
  const done = `some output\r\nroot@host:~# `
  assert.equal(hasReturnedPrompt(done, null), true)
})

test('折行回显片段识别', () => {
  assert.equal(isCommandEchoFragment('tail -10 /root/autodl-tmp/hfd_logs/stdout.log 2>', COMMAND), true)
  assert.equal(isCommandEchoFragment('root@host:~#', COMMAND), false)
})

test('cleanPromptCapturedOutput 剥离折行回显与结尾 prompt', () => {
  const raw =
    `${PROMPT} sleep 5; ps -p 2128 -o pid,etime,cmd 2>/dev/null; echo "---log tail---";\r\n` +
    ` tail -20 /root/autodl-tmp/hfd_logs/download.log 2>/dev/null; echo "---stdout tail---";\r\n` +
    ` tail -10 /root/autodl-tmp/hfd_logs/stdout.log 2>/dev/null\r\n` +
    ` 2128    01:23 hfd\r\n` +
    `---log tail---\r\n` +
    `line1\r\nline2\r\n` +
    `---stdout tail---\r\n` +
    `ok\r\n` +
    `${PROMPT} `
  const cleaned = cleanPromptCapturedOutput(raw, COMMAND)
  assert.equal(cleaned, '2128    01:23 hfd\n---log tail---\nline1\nline2\n---stdout tail---\nok')
})

test('cleanPromptCapturedOutput 单行回显仍按原逻辑剥离', () => {
  const raw = `${PROMPT} ls -la\r\ntotal 8\r\n${PROMPT} `
  assert.equal(cleanPromptCapturedOutput(raw, 'ls -la'), 'total 8')
})

test('isShellPromptLine 常见 prompt 与非 prompt', () => {
  assert.equal(isShellPromptLine('root@host:~#'), true)
  assert.equal(isShellPromptLine('[user@host /var/log]$'), true)
  assert.equal(isShellPromptLine('downloaded 10/12'), false)
})
