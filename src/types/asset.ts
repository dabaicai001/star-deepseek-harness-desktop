export type AssetType = 'ssh' | 'db' | 'docker'

export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis'

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

  // 数据库配置
  dbType?: DatabaseType
  database?: string
  ssl?: boolean

  // Docker 配置
  socketPath?: string
  remoteHost?: string
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
