// @vitest-environment jsdom
/**
 * Redis 服务层(redis-service.ts):命令转发参数、预览模式拒绝,以及 redisQuote 纯函数边界。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  redisConnect, redisDBSize, redisDel, redisDisconnect, redisExecute, redisFlushDB,
  redisGetValue, redisInfo, redisQuote, redisRename, redisScan, redisSelect, redisSet,
} from '../src/client/redis/redis-service.ts'

/** 安装 Tauri IPC stub,记录 invoke 调用并返回预设结果;返回还原原状态的回调。 */
function stubInvoke(handler: (cmd: string, args?: Record<string, unknown>) => unknown): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } }
  const prev = w.__TAURI_INTERNALS__
  w.__TAURI_INTERNALS__ = { invoke: handler }
  return () => {
    if (prev === undefined) delete w.__TAURI_INTERNALS__
    else w.__TAURI_INTERNALS__ = prev
  }
}

/** 记录命令与参数的 invoke helper。 */
function recordingInvoke() {
  const calls: Array<[string, Record<string, unknown> | undefined]> = []
  const invokeFn = (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    switch (cmd) {
      case 'db_redis_connect': return Promise.resolve({ connId: 'c1', host: 'h', port: 6379 })
      case 'db_redis_disconnect': return Promise.resolve(null)
      case 'db_redis_select': return Promise.resolve(null)
      case 'db_redis_db_size': return Promise.resolve({ size: 42 })
      case 'db_redis_scan': return Promise.resolve({ keys: [{ key: 'a', type: 'string', ttl: -1 }], cursor: 0, total: 1 })
      case 'db_redis_get_value': return Promise.resolve({ key: 'k', type: 'string', value: 'v', ttl: -1 })
      case 'db_redis_del': return Promise.resolve({ deleted: 1 })
      case 'db_redis_rename': return Promise.resolve(null)
      case 'db_redis_set': return Promise.resolve(null)
      case 'db_redis_execute': return Promise.resolve({ result: 'OK', durationMs: 1 })
      case 'db_redis_flush_db': return Promise.resolve(null)
      case 'db_redis_info': return Promise.resolve('INFO...')
      default: return Promise.resolve(null)
    }
  }
  return { call: invokeFn, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

describe('redis service commands', () => {
  it('forwards connection lifecycle and DB commands with the right args', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await redisConnect({ host: 'h', port: 6379, password: 'p', db: 2, ssl: true })
      expect(calls[0]).toEqual(['db_redis_connect', { params: { host: 'h', port: 6379, password: 'p', db: 2, ssl: true } }])

      await redisDisconnect('c1')
      expect(calls[1]).toEqual(['db_redis_disconnect', { connId: 'c1' }])

      await redisSelect('c1', 3)
      expect(calls[2]).toEqual(['db_redis_select', { connId: 'c1', db: 3 }])

      const size = await redisDBSize('c1')
      expect(calls[3]).toEqual(['db_redis_db_size', { connId: 'c1' }])
      expect(size.size).toBe(42)
    } finally {
      restore()
    }
  })

  it('forwards scan with cursor/match defaults and count', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      await redisScan('c1', 0, 'user:*', 100)
      expect(calls[0]).toEqual(['db_redis_scan', { connId: 'c1', cursor: 0, matchPattern: 'user:*', count: 100 }])

      // cursor 缺省 → 0;match 缺省 → undefined
      await redisScan('c1')
      expect(calls[1]).toEqual(['db_redis_scan', { connId: 'c1', cursor: 0, matchPattern: undefined, count: undefined }])
    } finally {
      restore()
    }
  })

  it('forwards value read/write/delete/rename/execute/flush/info commands', async () => {
    const { call, calls } = recordingInvoke()
    const restore = stubInvoke(call)
    try {
      const val = await redisGetValue('c1', 'k')
      expect(calls[0]).toEqual(['db_redis_get_value', { connId: 'c1', key: 'k' }])
      expect(val.type).toBe('string')

      await redisDel('c1', ['a', 'b'])
      expect(calls[1]).toEqual(['db_redis_del', { connId: 'c1', keys: ['a', 'b'] }])

      await redisRename('c1', 'old', 'new')
      expect(calls[2]).toEqual(['db_redis_rename', { connId: 'c1', oldKey: 'old', newKey: 'new' }])

      await redisSet('c1', 'k', 'v', 60)
      expect(calls[3]).toEqual(['db_redis_set', { connId: 'c1', key: 'k', value: 'v', expiration: 60 }])

      // expiration 缺省 → undefined
      await redisSet('c1', 'k', 'v')
      expect(calls[4]).toEqual(['db_redis_set', { connId: 'c1', key: 'k', value: 'v', expiration: undefined }])

      await redisExecute('c1', 'GET k')
      expect(calls[5]).toEqual(['db_redis_execute', { connId: 'c1', command: 'GET k' }])

      await redisFlushDB('c1')
      expect(calls[6]).toEqual(['db_redis_flush_db', { connId: 'c1' }])

      await redisInfo('c1')
      expect(calls[7]).toEqual(['db_redis_info', { connId: 'c1', section: undefined }])

      await redisInfo('c1', 'memory')
      expect(calls[8]).toEqual(['db_redis_info', { connId: 'c1', section: 'memory' }])
    } finally {
      restore()
    }
  })

  it('rejects in browser preview when no Tauri internals are present', async () => {
    await expect(redisConnect({ host: 'h', port: 6379 })).rejects.toThrow('Tauri IPC unavailable')
  })
})

describe('redisQuote', () => {
  it('passes through safe tokens and quotes/escapes unsafe ones', () => {
    expect(redisQuote('abc-_.:@123')).toBe('abc-_.:@123')
    expect(redisQuote('has space')).toBe('"has space"')
    expect(redisQuote('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})
