/**
 * dsh 域工具执行器(AI 内核迁移 P1-5,新宿主层)。
 *
 * 职责:一个宿主面板(SSH 终端 / DB / Redis / ES / Docker / Excel)持有一个实例,
 * 执行 `dsh://tool-exec` 分派过来的域工具并返回文本结果;连接惰性建立,dispose 统一关闭。
 *
 * 与旧 `aiWorkspace.ts` 的关系:旧实现是「多资产直连 runtime + 工具定义 + 确认门」,
 * 现在工具定义与确认门都移到了 dsh 侧(starhub-tools 插件 + ask 门 → `dsh://approval`),
 * 本模块只剩「按工具名执行当前绑定资产」的分发逻辑,不再维护 LlmTool[] 定义与 confirmFn。
 *
 * 域约定(与 Rust 侧 starhub-tools 工具名对齐):
 * - SSH 域:ssh_exec / ssh_exec_confirmed / ssh_exec_background / ssh_wait_task + sftp_*
 * - 关系库域:db_query / db_query_confirmed(mysql/postgresql → mysqlExecute,clickhouse → clickhouseExecute)
 * - Redis 域:redis_exec / redis_exec_confirmed
 * - ES 域:es_*(_confirmed 后缀剥除后执行)
 * - Docker 域:docker_*(_confirmed 后缀剥除后执行)
 * - Excel 域:excel_* 一律转给 opts.excelExecute(ExcelView 传入操作当前工作簿的执行器)
 * - 全局工具:mcp_list / mcp_call(走 src/services/mcp.ts 封装)、skill_save(走 aiStore.upsertCustomSkill)
 * - 域不匹配(如 SSH 面板收到 db_query)返回错误文本引导模型
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  assetConfigToSshConfig,
  respondKeyboardInteractive,
  sshConnectExec,
  sshDisconnect,
  sshExec,
  type KbInteractiveEvent
} from '@/services/ssh'
import * as dbService from '@/services/db'
import * as dockerService from '@/services/docker'
import {
  formatSize,
  sftpEnsureSession,
  sftpList,
  sftpListTransfers,
  sftpStartDownload,
  sftpStartUpload,
  sftpStat,
  type TransferTask
} from '@/services/sftp'
import { callMcpTool, formatMcpResult, listMcpTools } from '@/services/mcp'
import { useAssetStore } from '@/stores/asset'
import type { Asset } from '@/types/asset'
import { useAiStore } from '@/stores/ai'
import type { DockerConnectParams } from '@/types/docker'
import type { QueryResult } from '@/types/db'
import { getUnsupportedSshCommandReason } from '@/utils/sshCommandPolicy'
import { scanMemoryContent } from '@/utils/memoryGuard'
import {
  buildBackgroundStartCommand,
  buildTaskPollCommand,
  clampTaskWaitSeconds,
  findLongSleepSeconds,
  isValidTaskId,
  newBackgroundTaskId
} from '@/utils/sshBackgroundTask'

/** 主机指纹确认信息(ssh:hostkey-confirm 事件载荷,与 aiWorkspace 的 HostKeyInfo 一致) */
export interface HostKeyInfo {
  hostname: string
  port: number
  remote: string
  keyType: string
  sha256: string
  sha1?: string
  md5?: string
}

/** createHostToolExecutor 选项 */
export interface HostToolExecutorOptions {
  /** 宿主域:ssh / db / redis / elasticsearch / docker / excel */
  assetType: string
  /** 绑定的资产 id(经资产 Store 解析连接配置) */
  assetId: string
  /** Excel 域:操作当前工作簿的执行器;未提供时 excel_* 一律报错 */
  excelExecute?: (name: string, args: Record<string, unknown>) => Promise<string>
  /**
   * SSH 命令执行覆盖(可选):由 SSH 终端宿主注入,把 ssh_exec / ssh_exec_background /
   * ssh_wait_task 路由到终端自身的执行通道(可见 PTY 或静默通道),保留 cwd 跟踪等
   * 终端语义;未提供时用执行器自建的 exec channel。
   */
  sshExecOverride?: (command: string, timeoutSec: number) => Promise<string>
  /**
   * 主机指纹确认桥:AI 直连 SSH 遇到未知主机时回调宿主确认(v1 沿用 aiWorkspace 做法,
   * 缺省拒绝并抛错,避免静默信任未知主机)。返回 true 表示信任并持久化。
   */
  confirmHostKey?: (info: HostKeyInfo) => Promise<boolean>
}

/** 执行器实例 */
export interface HostToolExecutor {
  execute: (name: string, args: Record<string, unknown>) => Promise<string>
  dispose: () => Promise<void>
}

interface DbConnection {
  connId: string
  kind: 'mysql' | 'postgresql' | 'clickhouse' | 'redis' | 'elasticsearch'
  database?: string
}

const TRANSFER_POLL_MS = 400
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000

/** 域名判定:工具名 → 归属域;全局工具(mcp/skill)恒可执行 */
function domainOf(name: string): string | null {
  if (name.startsWith('ssh_') || name.startsWith('sftp_')) return 'ssh'
  if (name.startsWith('db_')) return 'db'
  if (name.startsWith('redis_')) return 'redis'
  if (name.startsWith('es_')) return 'elasticsearch'
  if (name.startsWith('docker_')) return 'docker'
  if (name.startsWith('excel_')) return 'excel'
  if (name === 'mcp_list' || name === 'mcp_call') return 'mcp'
  if (name === 'skill_save') return 'skill'
  return null
}

function parseArgs(args: Record<string, unknown>): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value.map(row => Array.isArray(row) ? row.map(cell => String(cell ?? '')) : [String(row ?? '')])
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') return JSON.stringify(value)
  const text = String(value)
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function formatQueryResult(result: QueryResult): string {
  if (result.error) return `[Error] ${result.error}`
  if (result.rows.length === 0) return `(0 行${result.rowsAffected ? `, ${result.rowsAffected} 行受影响` : ''})`
  const names = result.columns.map(column => column.name)
  const rows = result.rows.slice(0, 20).map(row =>
    row.map((value, index) => `${names[index] || index}=${formatValue(value)}`).join(' | ')
  )
  return `列: ${names.join(', ')}\n${rows.join('\n')}${result.rows.length > 20 ? `\n… (共 ${result.rows.length} 行)` : ''}`
}

/** 按资产 id 从资产 Store 解析资产;找不到抛错 */
function resolveAsset(assetId: string): Asset {
  const asset = useAssetStore().assets.find(item => item.id === assetId)
  if (!asset) throw new Error(`资产不存在或已删除: ${assetId}`)
  return asset
}

// ====== SFTP 传输小工具(与旧 aiSftpTools 的校验/轮询语义一致) ======

function paths(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} 必须是路径数组`)
  const result = value.map(item => String(item).trim()).filter(Boolean)
  if (result.length === 0) throw new Error(`${field} 不能为空`)
  if (result.length > 20) throw new Error(`${field} 单次最多 20 个路径`)
  if (result.some(path => path.length > 4096)) throw new Error(`${field} 中存在过长路径`)
  return result
}

function requiredPath(value: unknown, field: string): string {
  const result = String(value ?? '').trim()
  if (!result) throw new Error(`${field} 不能为空`)
  if (result.length > 4096) throw new Error(`${field} 路径过长`)
  return result
}

function requiredRemotePath(value: unknown, field: string): string {
  const result = requiredPath(value, field)
  if (!result.startsWith('/') && !result.startsWith('~')) {
    throw new Error(`${field} 必须是远端绝对路径(以 / 或 ~ 开头),收到: ${result}`)
  }
  return result
}

function speedLimit(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

async function waitForTransfer(sessionId: string, transferId: string): Promise<TransferTask> {
  const deadline = Date.now() + TRANSFER_TIMEOUT_MS
  while (Date.now() < deadline) {
    const task = (await sftpListTransfers(sessionId)).find(item => item.id === transferId)
    if (task && (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')) {
      if (task.status === 'failed') throw new Error(task.error || `SFTP 传输失败: ${transferId}`)
      if (task.status === 'cancelled') throw new Error(`SFTP 传输已取消: ${transferId}`)
      return task
    }
    if (task && task.status === 'paused') {
      throw new Error(`SFTP 传输已被用户暂停: ${transferId}。如需继续,请在传输队列中恢复后重试。`)
    }
    await new Promise(resolve => setTimeout(resolve, TRANSFER_POLL_MS))
  }
  throw new Error(`SFTP 传输等待超过 30 分钟: ${transferId}`)
}

function transferSummary(task: TransferTask): string {
  return [
    `传输已完成 (${task.direction === 'upload' ? '上传' : '下载'})`,
    `任务: ${task.id}`,
    `文件: ${task.files.length}`,
    `大小: ${formatSize(task.totalBytes)}`
  ].join('\n')
}

/** 创建单资产域工具执行器 */
export function createHostToolExecutor(options: HostToolExecutorOptions): HostToolExecutor {
  const { assetType, assetId, excelExecute, confirmHostKey } = options
  const unlisteners = new Set<UnlistenFn>()
  let sshConnId: string | null = null
  let dbConn: Promise<DbConnection> | null = null
  let dockerConnId: Promise<string> | null = null

  function getAsset(): Asset {
    return resolveAsset(assetId)
  }

  // ====== SSH 连接:hostkey 确认桥 + keyboard-interactive 自动填充(沿用 aiWorkspace 做法) ======
  async function registerSshListeners(connId: string, asset: Asset): Promise<void> {
    const hostUnlisten = await listen<HostKeyInfo>(`ssh:hostkey-confirm:${connId}`, async event => {
      const info = event.payload
      const approved = confirmHostKey
        ? await confirmHostKey(info)
        : false
      await invoke('ssh_hostkey_response', { id: connId, allowed: approved, persist: approved })
    })
    unlisteners.add(hostUnlisten)

    const kbUnlisten = await listen<KbInteractiveEvent>(`ssh:kb-interactive:${connId}`, async event => {
      const fallback = asset.config.mfaPassword || asset.config.password || ''
      const responses = event.payload.prompts.map((_, index) => event.payload.autoFill[index] ?? fallback)
      await respondKeyboardInteractive(connId, responses)
    })
    unlisteners.add(kbUnlisten)
  }

  async function ensureSsh(): Promise<string> {
    if (sshConnId) return sshConnId
    const asset = getAsset()
    if (!asset.config.host || !asset.config.username) {
      throw new Error(`SSH 资产配置不完整: ${asset.name}`)
    }
    const connId = `dsh:${assetId}:ssh`
    await registerSshListeners(connId, asset)
    // AI 只通过 ssh_exec 打开一次性命令 channel,不应额外申请 PTY 或启动登录 shell。
    await sshConnectExec(connId, assetConfigToSshConfig(asset.config))
    sshConnId = connId
    return connId
  }

  // ====== DB / Redis / ES 连接 ======
  async function connectDb(): Promise<DbConnection> {
    const asset = getAsset()
    const config = asset.config
    const kind = config.dbType || 'mysql'
    if (kind === 'mysql') {
      const result = await dbService.mysqlConnect({
        host: config.host || '', port: config.port || 3306, username: config.username || '',
        password: config.password || '', database: config.database, ssl: config.ssl
      })
      return { connId: result.connId, kind, database: config.database }
    }
    if (kind === 'postgresql') {
      const result = await dbService.postgresConnect({
        host: config.host || '', port: config.port || 5432, username: config.username || '',
        password: config.password || '', database: config.database || 'postgres', ssl: config.ssl
      })
      return { connId: result.connId, kind, database: config.database }
    }
    if (kind === 'clickhouse') {
      const result = await dbService.clickhouseConnect({
        host: config.host || '', port: config.port || 9000, username: config.username || '',
        password: config.password || '', database: config.database, ssl: config.ssl
      })
      return { connId: result.connId, kind, database: config.database }
    }
    if (kind === 'redis') {
      const result = await dbService.redisConnect({
        host: config.host || '', port: config.port || 6379, password: config.password,
        db: config.redisDb || 0, ssl: config.ssl
      })
      return { connId: result.connId, kind }
    }
    if (kind === 'elasticsearch') {
      const result = await dbService.esConnect({
        addresses: config.addresses, address: config.address, host: config.host || 'localhost',
        port: config.port || 9200, username: config.username, password: config.password, useSSL: config.ssl
      })
      return { connId: result.connId, kind }
    }
    throw new Error(`当前宿主暂不支持直接连接 ${kind} 工作区`)
  }

  function ensureDb(): Promise<DbConnection> {
    if (dbConn) return dbConn
    const pending = connectDb()
    dbConn = pending
    pending.catch(() => { dbConn = null })
    return pending
  }

  // ====== Docker 连接(transport: socket / tcp / ssh,参考 aiWorkspace.dockerParams) ======
  async function dockerParams(config: Asset['config']): Promise<DockerConnectParams> {
    const transport = config.dockerTransport || (config.remoteHost ? 'tcp' : 'socket')
    if (transport === 'tcp') return { transport: 'tcp', host: config.remoteHost || 'tcp://127.0.0.1:2375' }
    if (transport === 'socket') {
      const socketPath = config.socketPath || '/var/run/docker.sock'
      return { transport: 'socket', host: socketPath.includes('://') ? socketPath : `unix://${socketPath}` }
    }
    const assetStore = useAssetStore()
    const sshAsset = assetStore.assets.find(item => item.id === config.dockerSshAssetId)
    if (!sshAsset?.config.host || !sshAsset.config.username) {
      throw new Error('Docker SSH 传输依赖的 SSH 资产未找到或配置不完整')
    }
    const port = sshAsset.config.port || 22
    const knownHostKey = await invoke<string | null>('ssh_get_trusted_host_key', { host: sshAsset.config.host, port })
    if (!knownHostKey) throw new Error(`Docker SSH 主机 ${sshAsset.config.host}:${port} 尚未确认主机密钥`)
    let jumpKnownHostKey: string | undefined
    if (sshAsset.config.jumpHost) {
      jumpKnownHostKey = await invoke<string | null>('ssh_get_trusted_host_key', {
        host: sshAsset.config.jumpHost,
        port: sshAsset.config.jumpPort || 22
      }) || undefined
      if (!jumpKnownHostKey) throw new Error(`跳板机 ${sshAsset.config.jumpHost}:${sshAsset.config.jumpPort || 22} 尚未确认主机密钥`)
    }
    return {
      transport: 'ssh',
      socketPath: config.socketPath || '/var/run/docker.sock',
      ssh: {
        host: sshAsset.config.host,
        port,
        username: sshAsset.config.username,
        password: sshAsset.config.password,
        privateKey: sshAsset.config.privateKey,
        passphrase: sshAsset.config.passphrase,
        knownHostKey,
        jumpHost: sshAsset.config.jumpHost,
        jumpPort: sshAsset.config.jumpPort,
        jumpUsername: sshAsset.config.jumpUsername,
        jumpPassword: sshAsset.config.jumpPassword,
        jumpPrivateKey: sshAsset.config.jumpPrivateKey,
        jumpPassphrase: sshAsset.config.jumpPassphrase,
        jumpKnownHostKey,
        protocol: config.dockerSshProtocol || 'unix-over-nc-sudo'
      }
    }
  }

  function ensureDocker(): Promise<string> {
    if (dockerConnId) return dockerConnId
    const pending = (async () => {
      const result = await dockerService.dockerConnect(await dockerParams(getAsset().config))
      return result.connId
    })()
    dockerConnId = pending
    pending.catch(() => { dockerConnId = null })
    return pending
  }

  // ====== 各域执行 ======

  async function executeSsh(name: string, args: Record<string, unknown>): Promise<string> {
    if (name.startsWith('sftp_')) return executeSftp(name, args)

    const runCommand = async (command: string, timeoutSec: number) =>
      options.sshExecOverride ? options.sshExecOverride(command, timeoutSec) : sshExec(await ensureSsh(), command, timeoutSec)

    if (name === 'ssh_wait_task') {
      const taskId = asString(args.task_id).trim()
      if (!isValidTaskId(taskId)) return '[Error] 无效的 task_id'
      const waitSec = clampTaskWaitSeconds(args.wait_seconds)
      try {
        // 轮询命令(内部带 sleep)独立执行;远端非 0 退出时错误消息里已含已收到的 stdout
        const output = await runCommand(buildTaskPollCommand(taskId, waitSec), waitSec + 15)
        return output || '(无输出)'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }

    const command = asString(args.command).trim()
    if (!command) return '[Error] Empty command'

    const isBackground = name === 'ssh_exec_background'
    const unsupportedReason = getUnsupportedSshCommandReason(command)
    if (unsupportedReason) {
      throw new Error(`SSH AI 工具只支持可自行结束的非交互命令: ${unsupportedReason}`)
    }
    // 前台命令不允许长时间 sleep(会阻塞执行通道),引导改用后台任务工具
    if (!isBackground) {
      const sleepSec = findLongSleepSeconds(command)
      if (sleepSec != null) {
        throw new Error(`命令包含 sleep 约 ${Math.round(sleepSec)} 秒的长时间等待;请改用 ssh_exec_background 后台执行,再用 ssh_wait_task 轮询结果`)
      }
    }

    const taskId = isBackground ? newBackgroundTaskId() : null
    const finalCommand = taskId ? buildBackgroundStartCommand(command, taskId) : command
    const output = await runCommand(finalCommand, 30)
    if (taskId) {
      return `${output}\n后台任务已启动,task_id: ${taskId};请调用 ssh_wait_task(task_id="${taskId}") 查询进度与结果。`
    }
    return output || '(无输出)'
  }

  async function executeSftp(name: string, args: Record<string, unknown>): Promise<string> {
    const connId = await ensureSsh()
    await sftpEnsureSession(connId)

    if (name === 'sftp_list') {
      const path = requiredRemotePath(args.path, 'path')
      const entries = await sftpList(connId, path)
      const lines = entries.slice(0, 200).map(entry => [
        entry.isDir ? 'DIR ' : 'FILE',
        entry.path,
        entry.isDir ? '-' : formatSize(entry.size),
        entry.permissions.toString(8)
      ].join(' | '))
      if (entries.length > 200) lines.push(`… (共 ${entries.length} 项,仅显示前 200 项)`)
      return lines.join('\n') || '(空目录)'
    }

    if (name === 'sftp_stat') {
      const path = requiredRemotePath(args.path, 'path')
      return JSON.stringify(await sftpStat(connId, path), null, 2)
    }

    if (name === 'sftp_upload') {
      const localPaths = paths(args.localPaths, 'localPaths')
      const remoteDir = requiredRemotePath(args.remoteDir, 'remoteDir')
      const transferId = await sftpStartUpload(connId, localPaths, remoteDir, speedLimit(args.speedLimit))
      return transferSummary(await waitForTransfer(connId, transferId))
    }

    if (name === 'sftp_download') {
      const remotePaths = paths(args.remotePaths, 'remotePaths').map(p => requiredRemotePath(p, 'remotePaths'))
      const localDir = requiredPath(args.localDir, 'localDir')
      const transferId = await sftpStartDownload(connId, remotePaths, localDir, speedLimit(args.speedLimit))
      return transferSummary(await waitForTransfer(connId, transferId))
    }

    throw new Error(`Unknown SFTP tool: ${name}`)
  }

  async function executeRelationalDb(name: string, args: Record<string, unknown>): Promise<string> {
    const connection = await ensureDb()
    if (connection.kind !== 'mysql' && connection.kind !== 'postgresql' && connection.kind !== 'clickhouse') {
      throw new Error(`工具 ${name} 属于关系数据库域,当前连接类型是 ${connection.kind}`)
    }
    const sql = asString(args.sql).trim()
    if (!sql) return '[Error] Empty SQL'
    const result = connection.kind === 'clickhouse'
      ? await dbService.clickhouseExecute(connection.connId, sql, connection.database)
      : await dbService.mysqlExecute(connection.connId, sql, connection.database)
    return formatQueryResult(result)
  }

  async function executeRedis(name: string, args: Record<string, unknown>): Promise<string> {
    const connection = await ensureDb()
    const command = asString(args.command).trim()
    if (!command) return '[Error] Empty command'
    const result = await dbService.redisExecute(connection.connId, command)
    if (result.error) return `[Error] ${result.error}`
    return result.result == null ? '(无输出)'
      : typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2)
  }

  async function executeEs(name: string, args: Record<string, unknown>): Promise<string> {
    const connection = await ensureDb()
    if (name === 'es_list_indices') {
      const indices = await dbService.esListIndices(connection.connId)
      return JSON.stringify(indices.map(index => ({ name: index.name, docs: index.docsCount, size: index.storeSize, health: index.health })), null, 2)
    }
    if (name === 'es_cluster_health') return JSON.stringify(await dbService.esClusterHealth(connection.connId), null, 2)
    if (name === 'es_get_mapping') return JSON.stringify(await dbService.esGetMapping(connection.connId, asString(args.index)), null, 2)
    if (name === 'es_search') {
      let query: Record<string, unknown>
      try { query = JSON.parse(asString(args.query)) as Record<string, unknown> } catch { throw new Error('Invalid JSON in query DSL') }
      return JSON.stringify(await dbService.esSearch(connection.connId, asString(args.index), query, asNumber(args.from), asNumber(args.size, 20)), null, 2)
    }
    if (name === 'es_get_document') return JSON.stringify(await dbService.esGetDocument(connection.connId, asString(args.index), asString(args.id)), null, 2)
    if (name === 'es_count') {
      let query: Record<string, unknown> | undefined
      if (args.query) query = JSON.parse(asString(args.query)) as Record<string, unknown>
      return JSON.stringify(await dbService.esCount(connection.connId, asString(args.index), query), null, 2)
    }
    if (name === 'es_index_document') {
      const body = JSON.parse(asString(args.body)) as Record<string, unknown>
      return JSON.stringify(await dbService.esIndexDocument(connection.connId, asString(args.index), body, asString(args.id) || undefined), null, 2)
    }
    if (name === 'es_delete_document') return JSON.stringify(await dbService.esDeleteDocument(connection.connId, asString(args.index), asString(args.id)), null, 2)
    if (name === 'es_delete_index') return JSON.stringify(await dbService.esDeleteIndex(connection.connId, asString(args.index)), null, 2)
    throw new Error(`Unknown Elasticsearch tool: ${name}`)
  }

  async function executeDocker(name: string, args: Record<string, unknown>): Promise<string> {
    const connId = await ensureDocker()
    if (name === 'docker_list_containers') {
      const containers = await dockerService.listContainers(connId, args.all !== 'false')
      return containers.slice(0, 50).map(container =>
        `${container.id.slice(0, 12)} | ${container.name} | ${container.image} | ${container.state} | ${container.status}`
      ).join('\n') || '(没有容器)'
    }
    if (name === 'docker_logs') {
      const logs = await dockerService.containerLogs(connId, asString(args.container), asString(args.tail || '200'))
      return logs.map(log => `[${log.stream}] ${log.message}`).join('\n') || '(无日志)'
    }
    if (name === 'docker_inspect') return JSON.stringify(await dockerService.inspectContainer(connId, asString(args.target)), null, 2)
    if (name === 'docker_exec') {
      const result = await dockerService.dockerExec(
        connId,
        asString(args.container),
        ['sh', '-c', asString(args.command || '')],
        { timeoutSec: 30 }
      )
      return [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : '', result.exitCode ? `[exit ${result.exitCode}]` : '']
        .filter(Boolean).join('\n') || '(无输出)'
    }
    throw new Error(`Unknown Docker tool: ${name}`)
  }

  async function executeMcp(name: string, args: Record<string, unknown>): Promise<string> {
    const aiStore = useAiStore()
    const servers = (await aiStore.getMcpServers()).filter(server => server.enabled)
    if (servers.length === 0) return '当前没有启用的 MCP Server,请先在 设置 → AI → MCP 中配置。'

    const pick = (): typeof servers[number] => {
      const requested = asString(args.server).trim()
      if (requested) {
        const target = servers.find(server =>
          server.name.toLowerCase() === requested.toLowerCase() || server.id === requested
        )
        if (!target) throw new Error(`MCP Server 不存在或未启用: ${requested}`)
        return target
      }
      if (servers.length === 1) return servers[0]
      throw new Error(`存在多个 MCP Server,调用 ${name} 时必须指定 server: ${servers.map(s => s.name).join(', ')}`)
    }

    if (name === 'mcp_list') {
      const target = pick()
      const tools = await listMcpTools(target)
      return JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description || '' })), null, 2)
    }
    const target = pick()
    const toolName = asString(args.tool).trim()
    if (!toolName) throw new Error('mcp_call 缺少 tool 参数')
    const callArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
      ? args.arguments as Record<string, unknown>
      : {}
    return formatMcpResult(await callMcpTool(target, toolName, callArgs))
  }

  const SKILL_ASSET_TYPES = ['ssh', 'db', 'docker', 'excel', 'local'] as const

  async function executeSkillSave(args: Record<string, unknown>): Promise<string> {
    const aiStore = useAiStore()
    const name = asString(args.name).trim()
    const description = asString(args.description).trim()
    const prompt = asString(args.prompt).trim()
    if (!name) return '[Error] name 不能为空'
    if (!prompt) return '[Error] prompt 不能为空(Skill 正文是注入 system prompt 的指引)'
    if (name.length > 60) return '[Error] name 过长(<= 60 字符),请用更简短的动宾短语'
    if (prompt.length > 8000) return '[Error] prompt 过长(<= 8000 字符),请提炼为步骤化要点'

    const assetTypes = Array.isArray(args.assetTypes)
      ? Array.from(new Set(
          args.assetTypes.filter((t): t is (typeof SKILL_ASSET_TYPES)[number] =>
            typeof t === 'string' && (SKILL_ASSET_TYPES as readonly string[]).includes(t))
        ))
      : []
    if (assetTypes.length === 0) assetTypes.push(assetType === 'redis' || assetType === 'elasticsearch' ? 'db' : (assetType as (typeof SKILL_ASSET_TYPES)[number]))

    // 与记忆写入同源的安全扫描:隐形 Unicode / prompt 注入 / 凭据字面量
    // (确认卡由 dsh 审批门负责,这里不再走 confirm)
    const scan = scanMemoryContent(prompt)
    if (!scan.ok) return `[Error] Skill 写入被安全策略拦截:${scan.reason}`

    const { created } = await aiStore.upsertCustomSkill({ name, description, prompt, assetTypes })
    return created
      ? `已保存 Skill「${name}」(作用域: ${assetTypes.join(', ')}),已在设置中启用,之后的会话自动生效`
      : `已更新同名 Skill「${name}」(作用域: ${assetTypes.join(', ')}),之后的会话自动生效`
  }

  async function execute(name: string, rawArgs: Record<string, unknown>): Promise<string> {
    const args = parseArgs(rawArgs)
    const domain = domainOf(name)

    // 全局工具:任何宿主都可执行
    if (name === 'skill_save') return executeSkillSave(args)
    if (name === 'mcp_list' || name === 'mcp_call') return executeMcp(name, args)

    // 域不匹配:返回错误文本引导模型(不 throw,原样回给模型让它换工具)
    if (!domain || domain !== assetType) {
      return `[Error] 工具 ${name} 不属于当前面板(${assetType})的工具域;请改用当前资产可用的工具(${assetType} 域工具或 mcp_* / skill_save)。`
    }

    if (assetType === 'ssh') return executeSsh(name, args)
    if (assetType === 'db') return executeRelationalDb(name, args)
    if (assetType === 'redis') return executeRedis(name, args)
    if (assetType === 'elasticsearch') return executeEs(name, args)
    if (assetType === 'docker') return executeDocker(name, args)

    // Excel 域:一律转给宿主提供的工作簿执行器
    if (!excelExecute) throw new Error('当前 Excel 面板未提供工作簿执行器,excel_* 工具不可用')
    return excelExecute(name, args)
  }

  async function dispose(): Promise<void> {
    for (const unlisten of unlisteners) unlisten()
    unlisteners.clear()

    const tasks: Array<Promise<unknown>> = []
    if (sshConnId) tasks.push(sshDisconnect(sshConnId))
    sshConnId = null

    if (dbConn) {
      try {
        const connection = await dbConn
        if (connection.kind === 'mysql') tasks.push(dbService.mysqlDisconnect(connection.connId))
        else if (connection.kind === 'postgresql') tasks.push(dbService.postgresDisconnect(connection.connId))
        else if (connection.kind === 'clickhouse') tasks.push(dbService.clickhouseDisconnect(connection.connId))
        else if (connection.kind === 'redis') tasks.push(dbService.redisDisconnect(connection.connId))
        else tasks.push(dbService.esDisconnect(connection.connId))
      } catch { /* 连接从未成功,无需关闭 */ }
      dbConn = null
    }

    if (dockerConnId) {
      try {
        tasks.push(dockerService.dockerDisconnect(await dockerConnId))
      } catch { /* 连接从未成功,无需关闭 */ }
      dockerConnId = null
    }

    await Promise.allSettled(tasks)
  }

  return { execute, dispose }
}
