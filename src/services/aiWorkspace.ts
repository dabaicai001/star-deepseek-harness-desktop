import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { LlmTool, LlmToolCall } from '@/services/ai'
import type { Asset, AssetConfig, DatabaseType } from '@/types/asset'
import type { DockerConnectParams } from '@/types/docker'
import type { QueryResult } from '@/types/db'
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
import { makeSftpToolCaller, sftpTools } from '@/utils/aiSftpTools'
import {
  dbTools,
  dockerTools,
  esTools,
  excelTools,
  makeDbToolCaller,
  makeDockerToolCaller,
  makeEsToolCaller,
  makeRedisToolCaller,
  makeSshToolCaller,
  redisTools,
  sshTools,
  type ToolConfirmCtx,
  type ToolConfirmFn
} from '@/utils/aiTools'

interface HostKeyInfo {
  hostname: string
  port: number
  remote: string
  keyType: string
  sha256: string
  sha1?: string
  md5?: string
}

interface DirectConnection {
  asset: Asset
  connId: string
  kind: 'ssh' | 'mysql' | 'postgresql' | 'clickhouse' | 'redis' | 'elasticsearch' | 'docker'
}

interface SheetData {
  sheetName: string
  columns: string[]
  rows: string[][]
  totalRows: number
}

interface ExcelConnection {
  asset: Asset
  connId: string
  prefix: 'file.excel' | 'file.csv'
  filePath: string
  sheetNames: string[]
  activeSheet: string
  sheets: Map<string, SheetData>
}

export interface DirectWorkspaceOptions {
  runtimeId: string
  assets: Asset[]
  /** 仅用于解析已授权工作区的连接依赖,不会暴露为 AI 可调用目标。 */
  dependencyAssets?: Asset[]
  getWhitelist: () => string[]
  confirm: ToolConfirmFn
}

export interface DirectWorkspaceRuntime {
  tools: LlmTool[]
  execute: (call: LlmToolCall) => Promise<string>
  close: () => Promise<void>
}

const DIRECT_EXCEL_TOOLS = new Set([
  'excel_get_context',
  'excel_read_range',
  'excel_write_cell',
  'excel_write_range',
  'excel_fill_formula',
  'excel_set_headers',
  'excel_add_sheet',
  'excel_remove_sheet',
  'excel_rename_sheet',
  'excel_switch_sheet',
  'excel_save'
])

const READ_ONLY_EXCEL_TOOLS = new Set(['excel_get_context', 'excel_read_range', 'excel_switch_sheet'])

function parseArgs(call: LlmToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function dbType(asset: Asset): DatabaseType {
  return asset.config.dbType || 'mysql'
}

function isRelational(asset: Asset): boolean {
  return asset.type === 'db' && ['mysql', 'postgresql', 'clickhouse'].includes(dbType(asset))
}

function matchesTool(asset: Asset, toolName: string): boolean {
  if (toolName.startsWith('ssh_')) return asset.type === 'ssh'
  if (toolName.startsWith('sftp_')) return asset.type === 'ssh'
  if (toolName.startsWith('redis_')) return asset.type === 'db' && dbType(asset) === 'redis'
  if (toolName.startsWith('es_')) return asset.type === 'db' && dbType(asset) === 'elasticsearch'
  if (toolName.startsWith('db_')) return isRelational(asset)
  if (toolName.startsWith('docker_')) return asset.type === 'docker'
  if (toolName.startsWith('excel_')) return asset.type === 'excel'
  return false
}

function addWorkspaceParameter(tool: LlmTool, required: boolean): LlmTool {
  return {
    ...tool,
    function: {
      ...tool.function,
      description: `${tool.function.description} 直接作用于当前会话 # 绑定的工作区,不会打开标签页。`,
      parameters: {
        ...tool.function.parameters,
        properties: {
          ...tool.function.parameters.properties,
          workspace: {
            type: 'string',
            description: '目标工作区的资产 id 或完整名称；同类仅授权一个工作区时可省略'
          }
        },
        required: required
          ? Array.from(new Set([...(tool.function.parameters.required || []), 'workspace']))
          : tool.function.parameters.required
      }
    }
  }
}

function buildTools(assets: Asset[]): LlmTool[] {
  const available = [
    ...sshTools,
    ...sftpTools,
    ...dbTools,
    ...redisTools,
    ...esTools,
    ...dockerTools,
    ...excelTools.filter(tool => DIRECT_EXCEL_TOOLS.has(tool.function.name))
  ].filter(tool => assets.some(asset => matchesTool(asset, tool.function.name)))

  return available.map(tool => {
    const candidates = assets.filter(asset => matchesTool(asset, tool.function.name))
    return addWorkspaceParameter(tool, candidates.length > 1)
  })
}

function resolveAsset(assets: Asset[], toolName: string, args: Record<string, unknown>): Asset {
  const candidates = assets.filter(asset => matchesTool(asset, toolName))
  const requested = String(args.workspace || '').trim().toLowerCase()
  if (requested) {
    const asset = candidates.find(candidate =>
      candidate.id.toLowerCase() === requested || candidate.name.toLowerCase() === requested
    )
    if (asset) return asset
    throw new Error(`工作区未包含在当前会话 # 绑定中: ${String(args.workspace)}`)
  }
  if (candidates.length === 1) return candidates[0]
  if (candidates.length === 0) throw new Error(`当前会话 # 绑定范围不支持工具 ${toolName}`)
  throw new Error(`存在多个可用工作区,调用 ${toolName} 时必须指定 workspace: ${candidates.map(asset => `${asset.id} (${asset.name})`).join(', ')}`)
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

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value.map(row => Array.isArray(row) ? row.map(cell => String(cell ?? '')) : [String(row ?? '')])
}

function columnLetter(index: number): string {
  let value = Math.max(0, index) + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

async function sidecarRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return invoke<T>('sidecar_rpc', { method, params })
}

/**
 * 为全局 StarHub AI 创建无标签页的工作区执行运行时。
 * 运行时严格限制在 options.assets,并复用各工作区现有的命令白名单与确认门。
 */
export function createDirectWorkspaceRuntime(options: DirectWorkspaceOptions): DirectWorkspaceRuntime {
  const connections = new Map<string, Promise<DirectConnection>>()
  const excelConnections = new Map<string, Promise<ExcelConnection>>()
  const unlisteners = new Set<UnlistenFn>()

  async function registerSshListeners(asset: Asset, sessionId: string): Promise<void> {
    const hostUnlisten = await listen<HostKeyInfo>(`ssh:hostkey-confirm:${sessionId}`, async event => {
      const info = event.payload
      const approved = await options.confirm({
        toolName: 'ssh_host_key',
        args: { workspace: asset.name, host: `${info.hostname}:${info.port}`, keyType: info.keyType, sha256: info.sha256 },
        reason: 'always-confirm',
        message: `首次连接 ${info.hostname}:${info.port},请核对主机指纹后确认。\n\n类型: ${info.keyType}\nSHA256: ${info.sha256}`
      })
      await invoke('ssh_hostkey_response', { id: sessionId, allowed: approved, persist: approved })
    })
    unlisteners.add(hostUnlisten)

    const kbUnlisten = await listen<KbInteractiveEvent>(`ssh:kb-interactive:${sessionId}`, async event => {
      const fallback = asset.config.mfaPassword || asset.config.password || ''
      const responses = event.payload.prompts.map((_, index) => event.payload.autoFill[index] ?? fallback)
      await respondKeyboardInteractive(sessionId, responses)
    })
    unlisteners.add(kbUnlisten)
  }

  async function connectSsh(asset: Asset): Promise<DirectConnection> {
    if (!asset.config.host || !asset.config.username) throw new Error(`SSH 工作区配置不完整: ${asset.name}`)
    const connId = `${options.runtimeId}:ssh:${asset.id}`
    await registerSshListeners(asset, connId)
    // AI 只通过 ssh_exec 打开一次性命令 channel，不应额外申请 PTY 或启动登录 shell。
    await sshConnectExec(connId, assetConfigToSshConfig(asset.config))
    return { asset, connId, kind: 'ssh' }
  }

  async function connectDb(asset: Asset): Promise<DirectConnection> {
    const config = asset.config
    const kind = dbType(asset)
    if (kind === 'mysql') {
      const result = await dbService.mysqlConnect({
        host: config.host || '', port: config.port || 3306, username: config.username || '',
        password: config.password || '', database: config.database, ssl: config.ssl
      })
      return { asset, connId: result.connId, kind }
    }
    if (kind === 'postgresql') {
      const result = await dbService.postgresConnect({
        host: config.host || '', port: config.port || 5432, username: config.username || '',
        password: config.password || '', database: config.database || 'postgres', ssl: config.ssl
      })
      return { asset, connId: result.connId, kind }
    }
    if (kind === 'clickhouse') {
      const result = await dbService.clickhouseConnect({
        host: config.host || '', port: config.port || 9000, username: config.username || '',
        password: config.password || '', database: config.database, ssl: config.ssl
      })
      return { asset, connId: result.connId, kind }
    }
    if (kind === 'redis') {
      const result = await dbService.redisConnect({
        host: config.host || '', port: config.port || 6379, password: config.password,
        db: config.redisDb || 0, ssl: config.ssl
      })
      return { asset, connId: result.connId, kind }
    }
    if (kind === 'elasticsearch') {
      const result = await dbService.esConnect({
        addresses: config.addresses, address: config.address, host: config.host || 'localhost',
        port: config.port || 9200, username: config.username, password: config.password, useSSL: config.ssl
      })
      return { asset, connId: result.connId, kind }
    }
    throw new Error(`全局 AI 暂不支持直接连接 ${kind} 工作区`)
  }

  async function dockerParams(config: AssetConfig): Promise<DockerConnectParams> {
    const transport = config.dockerTransport || (config.remoteHost ? 'tcp' : 'socket')
    if (transport === 'tcp') return { transport: 'tcp', host: config.remoteHost || 'tcp://127.0.0.1:2375' }
    if (transport === 'socket') {
      const socketPath = config.socketPath || '/var/run/docker.sock'
      return { transport: 'socket', host: socketPath.includes('://') ? socketPath : `unix://${socketPath}` }
    }
    const sshAsset = (options.dependencyAssets || options.assets).find(asset => asset.id === config.dockerSshAssetId)
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

  async function connectDocker(asset: Asset): Promise<DirectConnection> {
    const result = await dockerService.dockerConnect(await dockerParams(asset.config))
    return { asset, connId: result.connId, kind: 'docker' }
  }

  function getConnection(asset: Asset): Promise<DirectConnection> {
    const existing = connections.get(asset.id)
    if (existing) return existing
    const pending = asset.type === 'ssh'
      ? connectSsh(asset)
      : asset.type === 'db'
        ? connectDb(asset)
        : connectDocker(asset)
    connections.set(asset.id, pending)
    pending.catch(() => connections.delete(asset.id))
    return pending
  }

  async function getExcelConnection(asset: Asset): Promise<ExcelConnection> {
    const existing = excelConnections.get(asset.id)
    if (existing) return existing
    const pending = (async () => {
      const filePath = asset.config.filePath
      if (!filePath) throw new Error(`Excel 工作区没有文件路径: ${asset.name}`)
      const format = asset.config.format === 'csv' || filePath.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx'
      const prefix = format === 'csv' ? 'file.csv' as const : 'file.excel' as const
      const opened = await sidecarRpc<{
        connId: string
        filePath: string
        sheetNames: string[]
        initialData?: SheetData
        sheetsData?: SheetData[]
      }>(`${prefix}.open`, { filePath, format })
      const sheetList = opened.sheetsData?.length ? opened.sheetsData : opened.initialData ? [opened.initialData] : []
      return {
        asset,
        connId: opened.connId,
        prefix,
        filePath: opened.filePath,
        sheetNames: opened.sheetNames,
        activeSheet: opened.initialData?.sheetName || opened.sheetNames[0],
        sheets: new Map(sheetList.map(sheet => [sheet.sheetName, sheet]))
      }
    })()
    excelConnections.set(asset.id, pending)
    pending.catch(() => excelConnections.delete(asset.id))
    return pending
  }

  async function currentSheet(connection: ExcelConnection): Promise<SheetData> {
    const cached = connection.sheets.get(connection.activeSheet)
    if (cached) return cached
    const sheet = await sidecarRpc<SheetData>(`${connection.prefix}.readSheet`, {
      connId: connection.connId,
      sheetName: connection.activeSheet
    })
    connection.sheets.set(sheet.sheetName, sheet)
    return sheet
  }

  async function reloadSheet(connection: ExcelConnection): Promise<SheetData> {
    connection.sheets.delete(connection.activeSheet)
    return currentSheet(connection)
  }

  async function executeExcel(asset: Asset, name: string, args: Record<string, unknown>): Promise<string> {
    const connection = await getExcelConnection(asset)
    if (!READ_ONLY_EXCEL_TOOLS.has(name)) {
      const approved = await options.confirm({
        toolName: name,
        args: { ...args, workspace: asset.name },
        reason: 'always-confirm',
        message: `即将直接修改工作簿「${asset.name}」\n\n操作: ${name}\n参数: ${JSON.stringify(args, null, 2)}\n\n修改仅在调用 excel_save 后持久化到文件。`
      })
      if (!approved) throw new Error('[Rejected by user]')
    }

    if (name === 'excel_get_context') {
      const sheet = await currentSheet(connection)
      return JSON.stringify({
        workspace: asset.name, file: connection.filePath, activeSheet: connection.activeSheet,
        sheets: connection.sheetNames, columns: sheet.columns, totalRows: sheet.totalRows
      }, null, 2)
    }
    if (name === 'excel_switch_sheet') {
      const target = String(args.sheetName || '')
      if (!connection.sheetNames.includes(target)) throw new Error(`Sheet 不存在: ${target}`)
      connection.activeSheet = target
      await currentSheet(connection)
      return `已在无标签页运行时切换到 ${target}`
    }
    if (name === 'excel_read_range') {
      const sheet = await currentSheet(connection)
      const startRow = Math.max(0, asNumber(args.startRow))
      const rowCount = Math.min(100, Math.max(1, asNumber(args.rowCount, 20)))
      return JSON.stringify({ columns: sheet.columns, startRow, rows: sheet.rows.slice(startRow, startRow + rowCount) }, null, 2)
    }
    if (name === 'excel_write_cell' || name === 'excel_write_range' || name === 'excel_fill_formula') {
      let cells: Array<{ row: number; col: number; value: string }> = []
      if (name === 'excel_write_cell') {
        cells = [{ row: asNumber(args.row), col: asNumber(args.col), value: String(args.value ?? '') }]
      } else if (name === 'excel_write_range') {
        const row = asNumber(args.row)
        const col = asNumber(args.col)
        cells = asMatrix(args.values).flatMap((values, rowOffset) =>
          values.map((value, colOffset) => ({ row: row + rowOffset, col: col + colOffset, value }))
        )
      } else {
        const startRow = asNumber(args.startRow)
        const col = asNumber(args.col)
        const count = Math.min(1000, Math.max(1, asNumber(args.rowCount, 1)))
        const formula = String(args.formula || '')
        cells = Array.from({ length: count }, (_, offset) => {
          const row = startRow + offset
          return {
            row,
            col,
            value: formula
              .replaceAll('{excelRow}', String(row + 2))
              .replaceAll('{row}', String(row))
              .replaceAll('{col}', String(col))
              .replaceAll('{colLetter}', columnLetter(col))
          }
        })
      }
      await sidecarRpc(`${connection.prefix}.writeCells`, {
        connId: connection.connId,
        sheetName: connection.activeSheet,
        cells
      })
      await reloadSheet(connection)
      return `已在 ${connection.activeSheet} 写入 ${cells.length} 个单元格（尚未保存文件）`
    }
    if (name === 'excel_set_headers') {
      const headers = Array.isArray(args.headers) ? args.headers.map(value => String(value ?? '')) : []
      await sidecarRpc(`${connection.prefix}.writeHeaders`, {
        connId: connection.connId,
        sheetName: connection.activeSheet,
        headers
      })
      await reloadSheet(connection)
      return `已更新 ${headers.length} 个表头（尚未保存文件）`
    }
    if (name === 'excel_add_sheet') {
      if (connection.prefix === 'file.csv') throw new Error('CSV 不支持多个 Sheet')
      const sheetName = String(args.sheetName || '').trim()
      await sidecarRpc(`${connection.prefix}.addSheet`, { connId: connection.connId, sheetName })
      connection.sheetNames.push(sheetName)
      connection.activeSheet = sheetName
      return `已新增 Sheet ${sheetName}（尚未保存文件）`
    }
    if (name === 'excel_remove_sheet') {
      if (connection.prefix === 'file.csv') throw new Error('CSV 不支持删除 Sheet')
      const sheetName = String(args.sheetName || connection.activeSheet)
      await sidecarRpc(`${connection.prefix}.removeSheet`, { connId: connection.connId, sheetName })
      connection.sheetNames = connection.sheetNames.filter(item => item !== sheetName)
      connection.sheets.delete(sheetName)
      connection.activeSheet = connection.sheetNames[0]
      return `已删除 Sheet ${sheetName}（尚未保存文件）`
    }
    if (name === 'excel_rename_sheet') {
      if (connection.prefix === 'file.csv') throw new Error('CSV 不支持重命名 Sheet')
      const oldName = String(args.oldName || connection.activeSheet)
      const newName = String(args.newName || '').trim()
      await sidecarRpc(`${connection.prefix}.renameSheet`, { connId: connection.connId, oldName, newName })
      connection.sheetNames = connection.sheetNames.map(item => item === oldName ? newName : item)
      connection.sheets.delete(oldName)
      if (connection.activeSheet === oldName) connection.activeSheet = newName
      return `已将 Sheet ${oldName} 重命名为 ${newName}（尚未保存文件）`
    }
    if (name === 'excel_save') {
      await sidecarRpc(`${connection.prefix}.save`, { connId: connection.connId })
      return `已保存 ${connection.filePath}`
    }
    throw new Error(`无标签页 Excel 运行时不支持工具 ${name}`)
  }

  async function executeEs(connection: DirectConnection, name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'es_list_indices') {
      const indices = await dbService.esListIndices(connection.connId)
      return JSON.stringify(indices.map(index => ({ name: index.name, docs: index.docsCount, size: index.storeSize, health: index.health })), null, 2)
    }
    if (name === 'es_cluster_health') return JSON.stringify(await dbService.esClusterHealth(connection.connId), null, 2)
    if (name === 'es_get_mapping') return JSON.stringify(await dbService.esGetMapping(connection.connId, String(args.index)), null, 2)
    if (name === 'es_search') {
      let query: Record<string, unknown>
      try { query = JSON.parse(String(args.query)) as Record<string, unknown> } catch { throw new Error('Invalid JSON in query DSL') }
      return JSON.stringify(await dbService.esSearch(connection.connId, String(args.index), query, asNumber(args.from), asNumber(args.size, 20)), null, 2)
    }
    if (name === 'es_get_document') return JSON.stringify(await dbService.esGetDocument(connection.connId, String(args.index), String(args.id)), null, 2)
    if (name === 'es_count') {
      let query: Record<string, unknown> | undefined
      if (args.query) query = JSON.parse(String(args.query)) as Record<string, unknown>
      return JSON.stringify(await dbService.esCount(connection.connId, String(args.index), query), null, 2)
    }
    if (name === 'es_index_document_confirmed') {
      const body = JSON.parse(String(args.body)) as Record<string, unknown>
      return JSON.stringify(await dbService.esIndexDocument(connection.connId, String(args.index), body, args.id ? String(args.id) : undefined), null, 2)
    }
    if (name === 'es_delete_document_confirmed') return JSON.stringify(await dbService.esDeleteDocument(connection.connId, String(args.index), String(args.id)), null, 2)
    if (name === 'es_delete_index_confirmed') return JSON.stringify(await dbService.esDeleteIndex(connection.connId, String(args.index)), null, 2)
    throw new Error(`Unknown Elasticsearch tool: ${name}`)
  }

  async function executeDocker(connection: DirectConnection, name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'docker_list_containers') {
      const containers = await dockerService.listContainers(connection.connId, args.all !== 'false')
      return containers.slice(0, 50).map(container =>
        `${container.id.slice(0, 12)} | ${container.name} | ${container.image} | ${container.state} | ${container.status}`
      ).join('\n') || '(没有容器)'
    }
    if (name === 'docker_logs') {
      const logs = await dockerService.containerLogs(connection.connId, String(args.container), String(args.tail || '200'))
      return logs.map(log => `[${log.stream}] ${log.message}`).join('\n') || '(无日志)'
    }
    if (name === 'docker_inspect') return JSON.stringify(await dockerService.inspectContainer(connection.connId, String(args.target)), null, 2)
    if (name === 'docker_exec' || name === 'docker_exec_confirmed') {
      const result = await dockerService.dockerExec(
        connection.connId,
        String(args.container),
        ['sh', '-c', String(args.command || '')],
        { timeoutSec: 30 }
      )
      return [result.stdout, result.stderr ? `[stderr]\n${result.stderr}` : '', result.exitCode ? `[exit ${result.exitCode}]` : '']
        .filter(Boolean).join('\n') || '(无输出)'
    }
    throw new Error(`Unknown Docker tool: ${name}`)
  }

  async function execute(call: LlmToolCall): Promise<string> {
    const args = parseArgs(call)
    const asset = resolveAsset(options.assets, call.function.name, args)
    if (asset.type === 'excel') return executeExcel(asset, call.function.name, args)
    const connection = await getConnection(asset)
    const wrappedCall = { function: { name: call.function.name, arguments: JSON.stringify(args) } }

    if (connection.kind === 'ssh') {
      if (call.function.name.startsWith('sftp_')) {
        const caller = makeSftpToolCaller(
          connection.connId,
          context => options.confirm(withWorkspaceContext(context, asset)),
          asset.name
        )
        return caller(wrappedCall)
      }
      const caller = makeSshToolCaller(
        command => sshExec(connection.connId, command, 30),
        options.getWhitelist,
        context => options.confirm(withWorkspaceContext(context, asset))
      )
      return caller(wrappedCall)
    }
    if (connection.kind === 'mysql' || connection.kind === 'postgresql' || connection.kind === 'clickhouse') {
      const caller = makeDbToolCaller(async sql => {
        const result = connection.kind === 'clickhouse'
          ? await dbService.clickhouseExecute(connection.connId, sql, asset.config.database)
          : await dbService.mysqlExecute(connection.connId, sql, asset.config.database)
        return formatQueryResult(result)
      }, options.getWhitelist, context => options.confirm(withWorkspaceContext(context, asset)))
      return caller(wrappedCall)
    }
    if (connection.kind === 'redis') {
      const caller = makeRedisToolCaller(async command => {
        const result = await dbService.redisExecute(connection.connId, command)
        if (result.error) return `[Error] ${result.error}`
        return result.result == null ? '(无输出)' : typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2)
      }, options.getWhitelist, context => options.confirm(withWorkspaceContext(context, asset)))
      return caller(wrappedCall)
    }
    if (connection.kind === 'elasticsearch') {
      const caller = makeEsToolCaller(
        (name, toolArgs) => executeEs(connection, name, toolArgs),
        options.getWhitelist,
        context => options.confirm(withWorkspaceContext(context, asset))
      )
      return caller(wrappedCall)
    }
    const caller = makeDockerToolCaller(
      (name, toolArgs) => executeDocker(connection, name, toolArgs),
      options.getWhitelist,
      context => options.confirm(withWorkspaceContext(context, asset))
    )
    return caller(wrappedCall)
  }

  async function close(): Promise<void> {
    for (const unlisten of unlisteners) unlisten()
    unlisteners.clear()
    const settledConnections = await Promise.allSettled(connections.values())
    await Promise.allSettled(settledConnections.flatMap(result => {
      if (result.status !== 'fulfilled') return []
      const connection = result.value
      if (connection.kind === 'ssh') return [sshDisconnect(connection.connId)]
      if (connection.kind === 'mysql') return [dbService.mysqlDisconnect(connection.connId)]
      if (connection.kind === 'postgresql') return [dbService.postgresDisconnect(connection.connId)]
      if (connection.kind === 'clickhouse') return [dbService.clickhouseDisconnect(connection.connId)]
      if (connection.kind === 'redis') return [dbService.redisDisconnect(connection.connId)]
      if (connection.kind === 'elasticsearch') return [dbService.esDisconnect(connection.connId)]
      return [dockerService.dockerDisconnect(connection.connId)]
    }))
    const settledExcels = await Promise.allSettled(excelConnections.values())
    await Promise.allSettled(settledExcels.flatMap(result => result.status === 'fulfilled'
      ? [sidecarRpc(`${result.value.prefix}.close`, { connId: result.value.connId })]
      : []))
    connections.clear()
    excelConnections.clear()
  }

  return { tools: buildTools(options.assets), execute, close }
}

function withWorkspaceContext(context: ToolConfirmCtx, asset: Asset): ToolConfirmCtx {
  return {
    ...context,
    args: { ...context.args, workspace: asset.name },
    message: `目标工作区: ${asset.name}\n\n${context.message}`
  }
}
