import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { DbSession, QueryResult, DatabaseType } from '@/types/db'
import * as dbService from '@/services/db'

export interface QueryHistoryEntry {
  id: number
  connId: string
  sql: string
  executedAt: number
  durationMs: number
  rowsAffected?: number
  success: boolean
}

export const useDbStore = defineStore('db', () => {
  const sessions = ref<Map<string, DbSession>>(new Map())
  const currentConnId = ref<string | null>(null)
  const queryHistory = ref<QueryHistoryEntry[]>([])
  const queryResults = ref<Map<string, QueryResult>>(new Map())
  const isExecuting = ref(false)

  const currentSession = computed(() => {
    if (!currentConnId.value) return null
    return sessions.value.get(currentConnId.value) || null
  })

  const currentResult = computed(() => {
    if (!currentConnId.value) return null
    return queryResults.value.get(currentConnId.value) || null
  })

  async function connectMySQL(assetId: string, name: string, params: {
    host: string
    port: number
    username: string
    password: string
    database?: string
    ssl?: boolean
  }): Promise<DbSession> {
    const info = await dbService.mysqlConnect(params)
    const session: DbSession = {
      connId: info.connId,
      dbType: 'mysql',
      host: info.host,
      port: info.port,
      database: info.database || '',
      connected: true,
      name,
      assetId
    }
    sessions.value.set(info.connId, session)
    currentConnId.value = info.connId
    return session
  }

  async function connectRedis(assetId: string, name: string, params: {
    host: string
    port: number
    password?: string
    db: number
    ssl?: boolean
  }): Promise<DbSession> {
    const info = await dbService.redisConnect(params)
    const session: DbSession = {
      connId: info.connId,
      dbType: 'redis',
      host: info.host,
      port: info.port,
      database: `db${info.db || 0}`,
      connected: true,
      name,
      assetId
    }
    sessions.value.set(info.connId, session)
    currentConnId.value = info.connId
    return session
  }

  async function connectElasticsearch(assetId: string, name: string, params: {
    host: string
    port: number
    username?: string
    password?: string
    useSSL?: boolean
    apiKey?: string
  }): Promise<DbSession> {
    const info = await dbService.esConnect(params)
    const session: DbSession = {
      connId: info.connId,
      dbType: 'elasticsearch' as DatabaseType,
      host: info.host,
      port: info.port,
      database: info.clusterName,
      connected: true,
      name,
      assetId
    }
    sessions.value.set(info.connId, session)
    currentConnId.value = info.connId
    return session
  }

  async function connectClickHouse(assetId: string, name: string, params: {
    host: string
    port: number
    username: string
    password: string
    database?: string
    ssl?: boolean
  }): Promise<DbSession> {
    const info = await dbService.clickhouseConnect(params)
    const session: DbSession = {
      connId: info.connId,
      dbType: 'clickhouse',
      host: info.host,
      port: info.port,
      database: info.database || '',
      connected: true,
      name,
      assetId
    }
    sessions.value.set(info.connId, session)
    currentConnId.value = info.connId
    return session
  }

  async function disconnect(connId: string) {
    const session = sessions.value.get(connId)
    if (!session) return

    try {
      if (session.dbType === 'mysql') {
        await dbService.mysqlDisconnect(connId)
      } else if (session.dbType === 'redis') {
        await dbService.redisDisconnect(connId)
      } else if (session.dbType === 'elasticsearch') {
        await dbService.esDisconnect(connId)
      } else if (session.dbType === 'clickhouse') {
        await dbService.clickhouseDisconnect(connId)
      }
    } catch {
      // ignore disconnect errors
    }

    sessions.value.delete(connId)
    queryResults.value.delete(connId)
    if (currentConnId.value === connId) {
      const firstKey = sessions.value.size > 0 ? sessions.value.keys().next().value : undefined
      currentConnId.value = firstKey ?? null
    }
  }

  function setCurrentSession(connId: string) {
    if (sessions.value.has(connId)) {
      currentConnId.value = connId
    }
  }

  async function executeQuery(connId: string, sql: string): Promise<QueryResult> {
    isExecuting.value = true
    try {
      const result = await dbService.mysqlExecute(connId, sql)
      queryResults.value.set(connId, result)

      // Add to history
      queryHistory.value.unshift({
        id: Date.now(),
        connId,
        sql,
        executedAt: Date.now(),
        durationMs: result.durationMs,
        rowsAffected: result.rowsAffected,
        success: !result.error
      })

      // Keep history limited
      if (queryHistory.value.length > 500) {
        queryHistory.value = queryHistory.value.slice(0, 500)
      }

      return result
    } finally {
      isExecuting.value = false
    }
  }

  function clearResult(connId: string) {
    queryResults.value.delete(connId)
  }

  function getHistory(connId?: string): QueryHistoryEntry[] {
    if (connId) {
      return queryHistory.value.filter(h => h.connId === connId)
    }
    return queryHistory.value
  }

  // ─── Redis CLI History ───

  const redisCliHistory = ref<string[]>([])

  function addCliHistory(cmd: string) {
    redisCliHistory.value.unshift(cmd)
    if (redisCliHistory.value.length > 200) {
      redisCliHistory.value = redisCliHistory.value.slice(0, 200)
    }
  }

  function getCliHistory(): string[] {
    return redisCliHistory.value
  }

  return {
    sessions,
    currentConnId,
    queryHistory,
    queryResults,
    isExecuting,
    currentSession,
    currentResult,
    connectMySQL,
    connectRedis,
    connectElasticsearch,
    connectClickHouse,
    disconnect,
    setCurrentSession,
    executeQuery,
    clearResult,
    getHistory,
    redisCliHistory,
    addCliHistory,
    getCliHistory
  }
}, {
  persist: {
    paths: ['queryHistory']
  }
})
