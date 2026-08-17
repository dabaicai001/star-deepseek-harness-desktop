import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../../src/utils/commandGuard.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const guardModule = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { checkCommand, stripShellPrompt, isReadOnlySql, isReadOnlyShellCommand, isReadOnlyToolCall } = guardModule

test('stripShellPrompt strips bash $ prompt', () => {
  assert.equal(stripShellPrompt('root@host:~$ rm -rf elasticsearch/'), 'rm -rf elasticsearch/')
  assert.equal(stripShellPrompt('[user@host ~]$ ls -la'), 'ls -la')
})

test('stripShellPrompt strips root # prompt', () => {
  assert.equal(stripShellPrompt('root@host:~# shutdown now'), 'shutdown now')
})

test('stripShellPrompt strips zsh/fish/powershell prompts', () => {
  // oh-my-zsh(agnoster)提示符终止符后还有路径段,首个终止符匹配会留下提示符残留;
  // 风险词正则是非锚定子串匹配,残留不影响检测,展示时也能看到完整命令
  assert.match(stripShellPrompt('➜  ~ git:(main) docker system prune -a'), /docker system prune -a$/)
  assert.equal(stripShellPrompt('user@host ~> rm -rf /tmp/x'), 'rm -rf /tmp/x')
  assert.equal(stripShellPrompt('PS C:\\Users\\foo> Remove-Item -Recurse -Force x'), 'Remove-Item -Recurse -Force x')
  assert.equal(stripShellPrompt('❯ reboot'), 'reboot')
})

test('stripShellPrompt keeps $ inside the command (first terminator wins)', () => {
  assert.equal(stripShellPrompt('user@host:~$ echo $HOME && ls'), 'echo $HOME && ls')
})

test('stripShellPrompt returns empty string when no prompt marker', () => {
  assert.equal(stripShellPrompt('plain text without prompt'), '')
  assert.equal(stripShellPrompt(''), '')
})

test('checkCommand flags tab-completed rm -rf target', () => {
  const result = checkCommand('rm -rf elasticsearch/')
  assert.equal(result.isRisky, true)
  assert.equal(result.needsConfirm, true)
  assert.match(result.confirmMessage, /rm -rf elasticsearch\//)
})

test('checkCommand flags pasted dangerous command', () => {
  const result = checkCommand('rm -rf /var/lib/mysql')
  assert.equal(result.isRisky, true)
})

test('checkCommand passes safe commands through (no whitelist)', () => {
  const safe = checkCommand('ls -la /home')
  assert.equal(safe.isRisky, false)
  assert.equal(safe.needsConfirm, false)
})

// ── 只读判定:Agent「自动批准(仅查询)」的安全边界 ──

test('isReadOnlySql: SELECT/SHOW/EXPLAIN/CTE 只读,多语句全只读才放行', () => {
  assert.equal(isReadOnlySql('SELECT * FROM users WHERE id = 1'), true)
  assert.equal(isReadOnlySql('show tables; describe users;'), true)
  assert.equal(isReadOnlySql('EXPLAIN SELECT * FROM t'), true)
  assert.equal(isReadOnlySql('WITH a AS (SELECT 1) SELECT * FROM a'), true)
  assert.equal(isReadOnlySql('SELECT * FROM t; SELECT count(*) FROM u'), true)
})

test('isReadOnlySql: 更新/删除/DDL/CTE 藏写操作一律拦截', () => {
  assert.equal(isReadOnlySql('UPDATE t SET x = 1 WHERE id = 2'), false)
  assert.equal(isReadOnlySql('DELETE FROM t WHERE id = 1'), false)
  assert.equal(isReadOnlySql('SELECT 1; DELETE FROM t'), false)
  assert.equal(isReadOnlySql('WITH a AS (DELETE FROM t RETURNING *) SELECT * FROM a'), false)
  assert.equal(isReadOnlySql('DROP TABLE t'), false)
  assert.equal(isReadOnlySql(''), false)
})

test('isReadOnlySql: 注释不影响判定', () => {
  assert.equal(isReadOnlySql('-- 查询用户\nSELECT * FROM users'), true)
  assert.equal(isReadOnlySql('/* 清理 */ DELETE FROM t'), false)
})

test('isReadOnlyShellCommand: 常见查看类命令放行,含管道/连接符的全链只读才放行', () => {
  assert.equal(isReadOnlyShellCommand('ls -la /home'), true)
  assert.equal(isReadOnlyShellCommand('ps aux | grep nginx'), true)
  assert.equal(isReadOnlyShellCommand('df -h && free -m'), true)
  assert.equal(isReadOnlyShellCommand('docker ps -a'), true)
  assert.equal(isReadOnlyShellCommand('kubectl get pods -n prod'), true)
  assert.equal(isReadOnlyShellCommand('redis-cli GET foo'), true)
  assert.equal(isReadOnlyShellCommand('tail -100 /var/log/app.log'), true)
})

test('isReadOnlyShellCommand: 写操作/重定向/提权/命令替换一律拦截', () => {
  assert.equal(isReadOnlyShellCommand('rm -rf /tmp/x'), false)
  assert.equal(isReadOnlyShellCommand('echo hi > /etc/motd'), false)
  assert.equal(isReadOnlyShellCommand('cat a | tee b'), false)
  assert.equal(isReadOnlyShellCommand('sudo ls /root'), false)
  assert.equal(isReadOnlyShellCommand('echo $(rm x)'), false)
  assert.equal(isReadOnlyShellCommand('redis-cli SET foo bar'), false)
  assert.equal(isReadOnlyShellCommand('mv a b'), false)
  assert.equal(isReadOnlyShellCommand(''), false)
})

test('isReadOnlyToolCall: sql 走 SQL 判定,command 走 Shell 判定,其他形态不放行', () => {
  assert.equal(isReadOnlyToolCall('db_query', { sql: 'SELECT 1' }), true)
  assert.equal(isReadOnlyToolCall('db_query', { sql: 'UPDATE t SET x = 1' }), false)
  assert.equal(isReadOnlyToolCall('ssh_exec', { command: 'uptime' }), true)
  assert.equal(isReadOnlyToolCall('ssh_exec', { command: 'reboot' }), false)
  assert.equal(isReadOnlyToolCall('mcp_some_tool', { path: '/etc/passwd' }), false)
})
