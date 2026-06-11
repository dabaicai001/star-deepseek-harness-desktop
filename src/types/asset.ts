export type AssetType = 'ssh' | 'db' | 'docker'

export type DatabaseType = 'mysql' | 'postgresql' | 'sqlite' | 'redis' | 'elasticsearch'

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
  totpSecret?: string
  /**
   * 阿里云堡垒机风格:连接瞬间弹 6 位 TOTP 码输入框,自动拼到 password 末尾再提交。
   * 与 mfaEnabled 互斥(走 password auth 通道,而非标准 kb-interactive)。
   */
  appendTotpToPassword?: boolean
  /** 拼接格式:'none' 密码+码 / 'space' 密码+空格+码 / 'manual' 用户自己拼好 */
  totpAppendFormat?: 'none' | 'space' | 'manual'

  // 数据库配置
  dbType?: DatabaseType
  database?: string
  ssl?: boolean
  redisDb?: number

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
