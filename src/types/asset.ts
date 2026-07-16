export type AssetType = 'ssh' | 'db' | 'docker' | 'excel'

export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis' | 'elasticsearch' | 'clickhouse' | 'kafka' | 'nsq' | 'mssql'
export type SftpLaunchMode = 'auto' | 'subsystem' | 'custom'

export interface AssetGroup {
  id: number
  name: string
  parentId: number | null
  icon: string | null
  sortOrder: number
  createdAt: number
}

export interface Asset {
  id: string
  type: AssetType
  name: string
  groupId: number | null
  config: AssetConfig
  keyId: string | null
  tags: string[]
  favorite: boolean
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface AssetConfig {
  // SSH 配置
  host?: string
  port?: number
  username?: string
  password?: string
  privateKey?: string
  passphrase?: string
  authMode?: 'password' | 'key' | 'both' | 'mfa'
  /** SFTP 子系统初始化与单次请求超时，单位秒。 */
  sftpTimeoutSec?: number
  /** SFTP 服务端启动策略：自动诊断降级、仅标准子系统或指定远端程序。 */
  sftpLaunchMode?: SftpLaunchMode
  /** custom 模式使用的远端 Unix sftp-server 绝对路径。 */
  sftpServerPath?: string

  // 跳板机配置
  jumpHost?: string
  jumpPort?: number
  jumpUsername?: string
  jumpPassword?: string
  jumpPrivateKey?: string
  jumpPassphrase?: string

  // MFA / 2FA
  usePasswordAuth?: boolean
  useKeyAuth?: boolean
  mfaEnabled?: boolean
  mfaPassword?: string

  // 数据库配置
  dbType?: DatabaseType
  address?: string
  addresses?: string[]  // ES multi-node
  database?: string
  ssl?: boolean
  redisDb?: number

  // Docker 配置
  socketPath?: string
  remoteHost?: string
  dockerTransport?: 'socket' | 'tcp' | 'ssh'
  dockerSshAssetId?: string
  dockerSshProtocol?: 'unix-over-nc' | 'unix-over-nc-sudo'

  // Excel 配置
  filePath?: string
  format?: 'xlsx' | 'csv'
  activeSheet?: string
  frozenRows?: number
  frozenCols?: number
  columnWidths?: Record<number, number>
}

export interface CreateAssetDto {
  type: AssetType
  name: string
  groupId?: number
  config: AssetConfig
  tags?: string[]
}

export interface UpdateAssetDto {
  name?: string
  groupId?: number
  config?: Partial<AssetConfig>
  tags?: string[]
  favorite?: boolean
  lastUsedAt?: number
}
