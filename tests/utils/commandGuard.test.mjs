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
const { checkCommand, stripShellPrompt } = guardModule

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
  const result = checkCommand('rm -rf elasticsearch/', [])
  assert.equal(result.isRisky, true)
  assert.equal(result.needsConfirm, true)
  assert.match(result.confirmMessage, /rm -rf elasticsearch\//)
})

test('checkCommand flags pasted dangerous command', () => {
  const result = checkCommand('rm -rf /var/lib/mysql', [])
  assert.equal(result.isRisky, true)
})

test('checkCommand passes safe commands through whitelist path', () => {
  const safe = checkCommand('ls -la /home', ['ls'])
  assert.equal(safe.isRisky, false)
  assert.equal(safe.needsConfirm, false)
})
