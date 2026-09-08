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
const { extractOsc7Cwd, OSC7_INJECT_COMMAND, parsePwdOutput, parseLoginShell, buildOsc7InjectCommand, extractPromptCwd } = mod

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

// ====== 登录 shell 探测(静默 exec:`pwd; echo $0; ps -p $$ -o comm=`) ======

test('parseLoginShell: 从 $0 / ps 输出识别 shell 名', () => {
  assert.equal(parseLoginShell('/root\nbash\nbash'), 'bash')
  assert.equal(parseLoginShell('/root\n-bash\nbash'), 'bash') // login shell argv0
  assert.equal(parseLoginShell('/home/u\n/usr/bin/zsh\nzsh'), 'zsh') // 带路径的 $0
  assert.equal(parseLoginShell('/root\nfish\nfish'), 'fish')
  assert.equal(parseLoginShell('/root\ntcsh\ntcsh'), 'tcsh')
})

test('parseLoginShell: 无可识别行返回 null', () => {
  assert.equal(parseLoginShell('/root\n\n'), null)
  assert.equal(parseLoginShell(''), null)
  assert.equal(parseLoginShell('ps: invalid option'), null)
})

test('buildOsc7InjectCommand: bash/zsh/未知 → 通用命令', () => {
  assert.equal(buildOsc7InjectCommand(null), OSC7_INJECT_COMMAND)
  assert.equal(buildOsc7InjectCommand('bash'), OSC7_INJECT_COMMAND)
  assert.equal(buildOsc7InjectCommand('zsh'), OSC7_INJECT_COMMAND)
  assert.equal(buildOsc7InjectCommand('sh'), OSC7_INJECT_COMMAND)
})

test('buildOsc7InjectCommand: fish 走 fish_prompt 事件 hook', () => {
  const cmd = buildOsc7InjectCommand('fish')
  assert.ok(cmd.endsWith('\n'))
  assert.ok(cmd.includes('--on-event fish_prompt'))
  assert.ok(cmd.includes("__starhub_osc7"))
  assert.ok(cmd.includes('$PWD'))
})

test('buildOsc7InjectCommand: 注入免疫 shell 返回空串', () => {
  assert.equal(buildOsc7InjectCommand('csh'), '')
  assert.equal(buildOsc7InjectCommand('tcsh'), '')
  assert.equal(buildOsc7InjectCommand('pwsh'), '')
})

// ====== prompt 行路径提取(OSC 7 之外的第二条 cwd 信号) ======

test('extractPromptCwd: Debian 默认 PS1(root@host:/var/log#)', () => {
  assert.equal(extractPromptCwd('root@host:/var/log#', '/root'), '/var/log')
})

test('extractPromptCwd: ~ 按登录 home 展开', () => {
  assert.equal(extractPromptCwd('root@host:~#', '/root'), '/root')
  assert.equal(extractPromptCwd('[root@host ~]#', '/root'), '/root')
  assert.equal(extractPromptCwd('user@h:~/src$', '/home/u'), '/home/u/src')
})

test('extractPromptCwd: CentOS 方括号 PS1 的绝对路径', () => {
  assert.equal(extractPromptCwd('[root@host /var/log]#', '/root'), '/var/log')
})

test('extractPromptCwd: 行首路径 prompt(/etc/nginx$)', () => {
  assert.equal(extractPromptCwd('/etc/nginx$', '/root'), '/etc/nginx')
})

test('extractPromptCwd: 多个 token 取最后一个(离提示符最近的)', () => {
  assert.equal(extractPromptCwd('user@host ~ /opt$ ', '/home/u'), '/opt')
})

test('extractPromptCwd: home 未知时不猜 ~', () => {
  assert.equal(extractPromptCwd('root@host:~#', ''), null)
  assert.equal(extractPromptCwd('root@host:~#', 'relative'), null)
  // 绝对路径不依赖 home
  assert.equal(extractPromptCwd('root@host:/tmp#', ''), '/tmp')
})

test('extractPromptCwd: 无路径 / URL / 相对目录名返回 null', () => {
  assert.equal(extractPromptCwd('sh-5.1$', '/root'), null)
  assert.equal(extractPromptCwd('#', '/root'), null)
  // macOS zsh %1~ 的末级目录名形态:home 时显示 ~(可还原),其他目录显示
  // 相对末级名(不可还原)——后者保持 null,不误跟
  assert.equal(extractPromptCwd('host: ~ user%', '/home/u'), '/home/u')
  assert.equal(extractPromptCwd('host: Documents user%', '/home/u'), null)
  assert.equal(extractPromptCwd('visit https://a.com/x#', '/root'), null) // 协议相对
  assert.equal(extractPromptCwd('~root@host:~#', '/root'), '/root') // ~root 前缀不吞 ~ token
})
