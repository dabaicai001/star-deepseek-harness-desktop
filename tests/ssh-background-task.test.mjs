import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(__dirname, '../src/utils/sshBackgroundTask.ts'), 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const mod = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`)
const { AI_BG_TASK_ROOT, AI_BG_MAX_WAIT_S, AI_BG_LOG_TAIL_BYTES,
  newBackgroundTaskId, isValidTaskId, clampTaskWaitSeconds,
  buildBackgroundStartCommand, buildTaskPollCommand, findLongSleepSeconds } = mod

test('newBackgroundTaskId 生成合法且互不相同的 id', () => {
  const a = newBackgroundTaskId()
  const b = newBackgroundTaskId()
  assert.equal(isValidTaskId(a), true)
  assert.equal(isValidTaskId(b), true)
  assert.notEqual(a, b)
})

test('isValidTaskId 拒绝注入与非法输入', () => {
  assert.equal(isValidTaskId('task-1; rm -rf /'), false)
  assert.equal(isValidTaskId('$(whoami)'), false)
  assert.equal(isValidTaskId('../etc'), false)
  assert.equal(isValidTaskId(''), false)
  assert.equal(isValidTaskId('a'.repeat(65)), false)
  assert.equal(isValidTaskId('task-mb1234-abc'), true)
})

test('clampTaskWaitSeconds 收敛到 [1, 55],非法值回退 30', () => {
  assert.equal(clampTaskWaitSeconds(30), 30)
  assert.equal(clampTaskWaitSeconds(0), 1)
  assert.equal(clampTaskWaitSeconds(100), AI_BG_MAX_WAIT_S)
  assert.equal(clampTaskWaitSeconds(12.9), 12)
  assert.equal(clampTaskWaitSeconds(Number.NaN), 30)
  assert.equal(clampTaskWaitSeconds(undefined), 30)
})

test('buildBackgroundStartCommand:base64 落盘可无损还原原始命令(含多行与中文)', () => {
  const original = '#!/bin/bash\n# 中文注释:安装\necho "hello \'world\'"\nsleep 50\necho done\n'
  const taskId = 'task-abc123-x1'
  const cmd = buildBackgroundStartCommand(original, taskId)
  const m = cmd.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/)
  assert.ok(m, '应包含 base64 落盘片段')
  assert.equal(Buffer.from(m[1], 'base64').toString('utf8'), original)
  assert.ok(cmd.includes(`${AI_BG_TASK_ROOT}/${taskId}`))
  assert.ok(cmd.includes('nohup bash -c'))
  assert.ok(cmd.includes(`[TASK] ${taskId} STARTED`))
})

test('buildBackgroundStartCommand:整条命令自身不含长 sleep(瞬间返回)', () => {
  const cmd = buildBackgroundStartCommand('sleep 50; echo ok', 'task-abc123-x2')
  assert.equal(findLongSleepSeconds(cmd), null)
})

test('buildTaskPollCommand:包含等待窗口、状态分支与日志尾部', () => {
  const cmd = buildTaskPollCommand('task-abc123-x3', 40)
  assert.ok(cmd.includes(`${AI_BG_TASK_ROOT}/task-abc123-x3`))
  assert.ok(cmd.includes('[ "$i" -lt 40 ]'))
  assert.ok(cmd.includes('[STATUS] FINISHED EXIT='))
  assert.ok(cmd.includes('[STATUS] RUNNING PID='))
  assert.ok(cmd.includes('[STATUS] NOT_FOUND'))
  assert.ok(cmd.includes(`tail -c ${AI_BG_LOG_TAIL_BYTES}`))
})

test('buildTaskPollCommand:wait_seconds 越界时被收敛', () => {
  assert.ok(buildTaskPollCommand('task-abc123-x4', 999).includes(`-lt ${AI_BG_MAX_WAIT_S}`))
  assert.ok(buildTaskPollCommand('task-abc123-x5', 0).includes('-lt 1'))
})

test('findLongSleepSeconds:识别长时间 sleep(含 m/h 后缀)', () => {
  assert.equal(findLongSleepSeconds('sleep 50; if [ -f /tmp/x.pid ]; then echo ok; fi'), 50)
  assert.equal(findLongSleepSeconds('sleep 1m && echo ok'), 60)
  assert.equal(findLongSleepSeconds('sleep 2h'), 7200)
  assert.equal(findLongSleepSeconds('sleep 0.5'), null)
  assert.equal(findLongSleepSeconds('sleep 5; echo ok'), null)
  assert.equal(findLongSleepSeconds('echo "sleep" && ls'), null)
  assert.equal(findLongSleepSeconds('ps aux | grep sleeper'), null)
})
