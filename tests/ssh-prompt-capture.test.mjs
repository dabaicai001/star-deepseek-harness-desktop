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
const { hasReturnedPrompt, cleanPromptCapturedOutput, isCommandEchoFragment, isShellPromptLine,
  buildCompletionMarkerCommand, findCompletionMarker, isCompletionMarkerEchoLine, newCompletionMarkerId,
  createHiddenEchoFilter, COMPLETION_MARKER_ECHO_TEXT } = mod

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

// ====== 命令完成哨兵(printf OSC 标记) ======

const MARKER_ID = 't1abc'
const MARKER_CMD = buildCompletionMarkerCommand(MARKER_ID)

test('buildCompletionMarkerCommand 生成 printf 哨兵命令(顺路 OSC 7 上报 cwd)', () => {
  assert.equal(MARKER_CMD, `printf '\\033]777;starhub;ai-done;${MARKER_ID};%s\\007\\033]7;%s\\007' "$?" "$PWD"`)
})

test('newCompletionMarkerId 每次生成不同 ID', () => {
  assert.notEqual(newCompletionMarkerId(1), newCompletionMarkerId(1))
})

test('findCompletionMarker 命中真实哨兵输出并解析退出码', () => {
  const raw =
    `${PROMPT} ls\r\n` +
    `file1\r\nfile2\r\n` +
    `\x1b]777;starhub;ai-done;${MARKER_ID};0\x07\r\n` +
    `${PROMPT} `
  const match = findCompletionMarker(raw, MARKER_ID)
  assert.ok(match)
  assert.equal(match.exitCode, 0)
  // start 指向 ESC 字节,slice(0, start) 正好是完整命令输出
  assert.equal(raw.slice(match.start).startsWith('\x1b]777;'), true)
  assert.equal(raw.slice(0, match.start).endsWith('file2\r\n'), true)
})

test('findCompletionMarker 解析非 0 退出码', () => {
  const raw = `boom\r\n\x1b]777;starhub;ai-done;${MARKER_ID};127\x07`
  assert.equal(findCompletionMarker(raw, MARKER_ID)?.exitCode, 127)
})

test('findCompletionMarker 支持 ESC\\ (ST) 结尾', () => {
  const raw = `out\r\n\x1b]777;starhub;ai-done;${MARKER_ID};3\x1b\\`
  assert.equal(findCompletionMarker(raw, MARKER_ID)?.exitCode, 3)
})

test('findCompletionMarker 退出码为空(fish 不展开 $?)时退化为 null', () => {
  const raw = `out\r\n\x1b]777;starhub;ai-done;${MARKER_ID};\x07`
  const match = findCompletionMarker(raw, MARKER_ID)
  assert.ok(match)
  assert.equal(match.exitCode, null)
})

test('findCompletionMarker 不匹配哨兵命令的回显文本', () => {
  // 回显只有字面字符 `\033]777;...`(没有 ESC 字节),绝不能误判为命令完成
  const raw = `${PROMPT} ${MARKER_CMD}\r\n`
  assert.equal(findCompletionMarker(raw, MARKER_ID), null)
})

test('findCompletionMarker 不匹配其他命令的哨兵 ID', () => {
  const raw = `out\r\n\x1b]777;starhub;ai-done;other9;0\x07`
  assert.equal(findCompletionMarker(raw, MARKER_ID), null)
})

test('多行 for 循环 + 末行无换行:prompt 识别失败但哨兵命中(用户报告场景)', () => {
  const loopCmd =
    'for n in unet te mmproj vae; do\n' +
    '  echo "--- $n ---"\n' +
    '  tail -3 /root/autodl-tmp/hfd_logs/dl_$n.log 2>/dev/null\n' +
    'done'
  // tail 的末行日志不带换行,返回的 prompt 经哨兵后与输出粘连成一行,
  // hasReturnedPrompt 永远为 false;哨兵是独立字节序列,不受粘连影响
  const raw =
    `${PROMPT} ${loopCmd.split('\n')[0]}\r\n` +
    `>   echo "--- $n ---"\r\n` +
    `>   tail -3 /root/autodl-tmp/hfd_logs/dl_$n.log 2>/dev/null\r\n` +
    `> done\r\n` +
    `--- unet ---\r\nlog-a\r\n--- te ---\r\nlog-b\r\n--- mmproj ---\r\n--- vae ---\r\n` +
    `2026-08-09 partial-log-no-newline` +
    `\x1b]777;starhub;ai-done;${MARKER_ID};0\x07` +
    `${PROMPT} `
  assert.equal(hasReturnedPrompt(raw, PROMPT, loopCmd), false)
  const match = findCompletionMarker(raw, MARKER_ID)
  assert.ok(match)
  assert.equal(match.exitCode, 0)
})

test('isCompletionMarkerEchoLine 识别哨兵回显行', () => {
  assert.equal(isCompletionMarkerEchoLine(`${PROMPT} ${MARKER_CMD}`), true)
  assert.equal(isCompletionMarkerEchoLine('--- unet ---'), false)
})

test('findCompletionMarker 兼容顺路 OSC 7 后缀(同流中的 cwd 上报不影响退出码解析)', () => {
  const raw = `out\r\n\x1b]777;starhub;ai-done;${MARKER_ID};0\x07\x1b]7;/root\x07${PROMPT} `
  const match = findCompletionMarker(raw, MARKER_ID)
  assert.ok(match)
  assert.equal(match.exitCode, 0)
})

// ====== 渲染侧回显过滤器(哨兵 / 注入命令的回显对用户不可见) ======

const HIDDEN_LITERALS = [COMPLETION_MARKER_ECHO_TEXT, '__starhub_osc7']

test('createHiddenEchoFilter 整行剔除哨兵命令回显,保留命令输出与 prompt', () => {
  const filter = createHiddenEchoFilter(HIDDEN_LITERALS)
  const chunk =
    `${PROMPT} ls\r\n` +
    `file1\r\nfile2\r\n` +
    `${PROMPT} ${MARKER_CMD}\r\n` +
    `\x1b]777;starhub;ai-done;${MARKER_ID};0\x07\x1b]7;/root\x07${PROMPT} `
  const out = filter(chunk)
  assert.equal(out.includes(MARKER_CMD), false)
  assert.equal(out.includes('file1\r\nfile2\r\n'), true)
  // 真实 OSC 序列(ESC 字节)保留,xterm 只解析不渲染;AI 侧 buffer 不受影响
  assert.equal(out.includes(`\x1b]777;starhub;ai-done;${MARKER_ID};0\x07`), true)
  // 无换行的 prompt 行实时放行,不被扣留
  assert.equal(out.endsWith(`${PROMPT} `), true)
})

test('createHiddenEchoFilter 回显行跨 TCP 分片也能剔除', () => {
  const filter = createHiddenEchoFilter(HIDDEN_LITERALS)
  const full = `${PROMPT} ${MARKER_CMD}\r\nnext\r\n`
  const cut = full.indexOf('ai-done') - 3
  const out1 = filter(full.slice(0, cut))
  const out2 = filter(full.slice(cut))
  assert.equal((out1 + out2).includes('printf'), false)
  assert.equal(out2, 'next\r\n')
})

test('createHiddenEchoFilter 剔除 OSC 7 注入命令回显', () => {
  const filter = createHiddenEchoFilter(HIDDEN_LITERALS)
  const injectLine =
    `__starhub_osc7() { printf '\\033]7;%s\\007' "$PWD"; }; ` +
    'if [ -n "${ZSH_VERSION:-}" ]; then precmd_functions+=(__starhub_osc7); ' +
    'else PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}__starhub_osc7"; fi\r\n'
  const out = filter(`${PROMPT} ${injectLine}${PROMPT} `)
  assert.equal(out.includes('__starhub_osc7'), false)
  assert.equal(out.endsWith(`${PROMPT} `), true)
})
