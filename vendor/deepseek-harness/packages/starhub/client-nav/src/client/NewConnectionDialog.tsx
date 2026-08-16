/**
 * 新建/编辑连接对话框(壳内 React 小对话框,替代原整幅连接管理 iframe
 * overlay):类型下拉 + 公共字段(名称/主机/端口/用户名/密码)+ 各类型
 * 专有字段,提交走顶层帧 Tauri IPC(create_asset / update_asset /
 * delete_asset,与 src/services/asset.ts 同契约)。编辑模式从资产行预填,
 * 留空的密码/私钥字段不随更新提交(后端 merge 语义下保持原值),并多一个
 * 两步确认的删除入口。浏览器预览(无 Tauri IPC)只展示提示、禁用提交。
 */
import { useRef, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { tauriInvoke } from './tauri.ts'
import type { RustAsset } from './store.ts'
import s from './settings/settings.module.css'

/** 对话框支持的连接类型(展示顺序即数组顺序);db 系经 config.dbType 区分。 */
const CONN_KINDS = [
  { kind: 'ssh', label: 'SSH', defaultPort: 22 },
  { kind: 'mysql', label: 'MySQL', defaultPort: 3306 },
  { kind: 'postgresql', label: 'PostgreSQL', defaultPort: 5432 },
  { kind: 'clickhouse', label: 'ClickHouse', defaultPort: 8123 },
  { kind: 'redis', label: 'Redis', defaultPort: 6379 },
  { kind: 'elasticsearch', label: 'Elasticsearch', defaultPort: 9200 },
  { kind: 'kafka', label: 'Kafka', defaultPort: 9092 },
  { kind: 'nsq', label: 'NSQ', defaultPort: 4150 },
  { kind: 'docker', label: 'Docker', defaultPort: 0 },
] as const

/** 连接类型 key(CONN_KINDS[].kind)。 */
type ConnKind = (typeof CONN_KINDS)[number]['kind']

/** 编辑模式:资产 → 对话框类型 key(db 资产按 config.dbType,缺省 mysql)。 */
function kindOfAsset(asset: RustAsset): ConnKind {
  if (asset.type === 'ssh') return 'ssh'
  if (asset.type === 'docker') return 'docker'
  const dbType = typeof asset.config.dbType === 'string' ? asset.config.dbType : 'mysql'
  const hit = CONN_KINDS.find(k => k.kind === dbType)
  return hit !== undefined ? hit.kind : 'mysql'
}

/** 字符串配置字段读取(非串归空)。 */
function str(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

/** 数值配置字段读取(非有限数归缺省)。 */
function num(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 对话框入参:打开状态由父层(overlay)控制,asset 非空进入编辑模式。 */
export interface NewConnectionDialogProps {
  /** 编辑目标;null = 新建。 */
  asset: RustAsset | null
  /** 关闭(取消 / 提交成功 / 删除成功后)。 */
  onClose: () => void
  /** 提交或删除成功后刷新资产列表。 */
  onSaved: () => void
}

/**
 * Render the small dsh-style connection dialog (create / edit / delete).
 * State initializes from `asset` on mount — the parent remounts the dialog
 * per target (key), so no prop-watch syncing is needed.
 * @param props - dialog target + close/save callbacks.
 * @returns the dialog markup.
 */
export function NewConnectionDialog({ asset, onClose, onSaved }: NewConnectionDialogProps) {
  const editing = asset !== null
  const preview = typeof window === 'undefined'
    || (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === undefined
  const [kind, setKind] = useState<ConnKind>(() => (asset === null ? 'ssh' : kindOfAsset(asset)))
  const [name, setName] = useState(() => asset?.name ?? '')
  const [host, setHost] = useState(() => (asset === null ? '' : str(asset.config, 'host')))
  const [port, setPort] = useState(() => {
    if (asset !== null) return num(asset.config, 'port', 22)
    return CONN_KINDS[0].defaultPort
  })
  const [username, setUsername] = useState(() => (asset === null ? '' : str(asset.config, 'username')))
  const [password, setPassword] = useState('')
  const [database, setDatabase] = useState(() => (asset === null ? '' : str(asset.config, 'database')))
  const [redisDb, setRedisDb] = useState(() => (asset === null ? 0 : num(asset.config, 'db', 0)))
  const [ssl, setSsl] = useState(() => asset?.config.ssl === true)
  const [sshAuth, setSshAuth] = useState<'password' | 'key'>(() =>
    asset !== null && (asset.config.useKeyAuth === true || asset.config.authMode === 'key') ? 'key' : 'password')
  const [privateKey, setPrivateKey] = useState('')
  const [privateKeyName, setPrivateKeyName] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [dockerTransport, setDockerTransport] = useState<'socket' | 'tcp'>(() =>
    asset?.config.dockerTransport === 'tcp' ? 'tcp' : 'socket')
  const [dockerAddress, setDockerAddress] = useState(() => {
    if (asset === null) return ''
    return str(asset.config, 'remoteHost') || str(asset.config, 'socketPath')
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const keyFileRef = useRef<HTMLInputElement | null>(null)

  const kindMeta = CONN_KINDS.find(k => k.kind === kind) ?? CONN_KINDS[0]
  const isDb = kind !== 'ssh' && kind !== 'docker'
  const needsUsername = kind === 'ssh' || kind === 'mysql' || kind === 'postgresql' || kind === 'clickhouse'
  const hasDatabase = kind === 'mysql' || kind === 'postgresql' || kind === 'clickhouse'
  const canSubmit = !preview && !busy && name.trim() !== ''
    && (kind === 'docker' ? dockerTransport === 'socket' || dockerAddress.trim() !== '' : host.trim() !== '')
    && (!needsUsername || username.trim() !== '')
    && (kind !== 'ssh' || sshAuth === 'password' || editing || privateKey !== '')

  /** 切换类型(仅新建):带出缺省端口。 */
  const onKindChange = (next: ConnKind) => {
    setKind(next)
    const meta = CONN_KINDS.find(k => k.kind === next)
    if (meta !== undefined && meta.defaultPort > 0) setPort(meta.defaultPort)
  }

  /** 私钥文件选取(web FileReader,不经 fs 插件;2MB 上限与 embed 版一致)。 */
  const onKeyFile = (file: File | undefined) => {
    if (file === undefined) return
    if (file.size > 2 * 1024 * 1024) {
      setError('私钥文件超过 2MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setPrivateKey(typeof reader.result === 'string' ? reader.result : '')
      setPrivateKeyName(file.name)
      setError('')
    }
    reader.onerror = () => setError('私钥文件读取失败')
    reader.readAsText(file)
  }

  /** 组装 create/update 的 config(编辑模式留空的密码/私钥不提交,保持原值)。 */
  const buildConfig = (): Record<string, unknown> => {
    if (kind === 'ssh') {
      return {
        host: host.trim(),
        port,
        username: username.trim(),
        authMode: sshAuth,
        usePasswordAuth: sshAuth === 'password',
        useKeyAuth: sshAuth === 'key',
        password: password !== '' ? password : undefined,
        privateKey: sshAuth === 'key' && privateKey !== '' ? privateKey : undefined,
        passphrase: sshAuth === 'key' && passphrase !== '' ? passphrase : undefined,
      }
    }
    if (kind === 'docker') {
      return {
        dockerTransport,
        socketPath: dockerTransport === 'socket' ? (dockerAddress.trim() || '/var/run/docker.sock') : undefined,
        remoteHost: dockerTransport === 'tcp' ? dockerAddress.trim() : undefined,
      }
    }
    return {
      dbType: kind,
      host: host.trim(),
      port,
      username: username.trim() !== '' ? username.trim() : undefined,
      password: password !== '' ? password : undefined,
      database: hasDatabase && database.trim() !== '' ? database.trim() : undefined,
      db: kind === 'redis' ? redisDb : undefined,
      ssl,
    }
  }

  const onSubmit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      if (editing) {
        await tauriInvoke('update_asset', { id: asset.id, params: { name: name.trim(), config: buildConfig() } })
      } else {
        await tauriInvoke('create_asset', {
          params: {
            type: kind === 'ssh' ? 'ssh' : kind === 'docker' ? 'docker' : 'db',
            name: name.trim(),
            group_id: null,
            config: buildConfig(),
            tags: [],
          },
        })
      }
      onSaved()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    if (!editing || preview || busy) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      await tauriInvoke('delete_asset', { id: asset.id })
      onSaved()
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setConfirmingDelete(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={s.dialogBackdrop} role="presentation" onMouseDown={onClose}>
      <div
        className={s.dialogPanel}
        role="dialog"
        aria-label={editing ? '编辑连接' : '新建连接'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={s.dialogHead}>
          <span className={s.dialogTitle}>{editing ? `编辑连接 · ${asset.name}` : '新建连接'}</span>
          <button type="button" className={s.iconButton} aria-label="关闭" onClick={onClose}>
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        {preview && (
          <div className={s.hint}>浏览器预览模式:没有 StarHub 桌面端后端(Tauri IPC),请在桌面应用中管理连接。</div>
        )}
        <div className={s.formGrid}>
          <div className={s.formField}>
            <label className={s.fieldLabel} htmlFor="conn-kind">类型</label>
            <select
              id="conn-kind"
              className={s.select}
              value={kind}
              disabled={editing || preview}
              onChange={(event) => onKindChange(event.target.value as ConnKind)}
            >
              {CONN_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </div>
          <div className={s.formField}>
            <label className={s.fieldLabel} htmlFor="conn-name">名称 *</label>
            <input
              id="conn-name"
              className={s.input}
              value={name}
              disabled={preview}
              placeholder="连接名称"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {kind === 'docker' ? (
            <>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-docker-transport">连接方式</label>
                <select
                  id="conn-docker-transport"
                  className={s.select}
                  value={dockerTransport}
                  disabled={preview}
                  onChange={(event) => setDockerTransport(event.target.value === 'tcp' ? 'tcp' : 'socket')}
                >
                  <option value="socket">本机 Socket</option>
                  <option value="tcp">远程 TCP</option>
                </select>
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-docker-address">
                  {dockerTransport === 'tcp' ? '地址 *' : 'Socket 路径'}
                </label>
                <input
                  id="conn-docker-address"
                  className={s.input}
                  value={dockerAddress}
                  disabled={preview}
                  placeholder={dockerTransport === 'tcp' ? 'tcp://127.0.0.1:2375' : '/var/run/docker.sock'}
                  onChange={(event) => setDockerAddress(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-host">主机 *</label>
                <input
                  id="conn-host"
                  className={s.input}
                  value={host}
                  disabled={preview}
                  placeholder="127.0.0.1"
                  onChange={(event) => setHost(event.target.value)}
                />
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-port">端口</label>
                <input
                  id="conn-port"
                  className={s.input}
                  type="number"
                  value={port}
                  disabled={preview}
                  onChange={(event) => setPort(Number(event.target.value) || kindMeta.defaultPort)}
                />
              </div>
            </>
          )}
          {kind !== 'docker' && kind !== 'redis' && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-username">
                用户名{needsUsername ? ' *' : ''}
              </label>
              <input
                id="conn-username"
                className={s.input}
                value={username}
                disabled={preview}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
          )}
          {kind === 'ssh' && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-ssh-auth">认证方式</label>
              <select
                id="conn-ssh-auth"
                className={s.select}
                value={sshAuth}
                disabled={preview}
                onChange={(event) => setSshAuth(event.target.value === 'key' ? 'key' : 'password')}
              >
                <option value="password">密码</option>
                <option value="key">私钥</option>
              </select>
            </div>
          )}
          {kind !== 'docker' && (kind !== 'ssh' || sshAuth === 'password') && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-password">
                密码{editing ? '(留空保持不变)' : ''}
              </label>
              <input
                id="conn-password"
                className={s.input}
                type="password"
                value={password}
                disabled={preview}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}
          {kind === 'ssh' && sshAuth === 'key' && (
            <>
              <div className={s.formField}>
                <span className={s.fieldLabel}>私钥文件{editing ? '(不选保持不变)' : ''}</span>
                <div className={s.toolbar}>
                  <button
                    type="button"
                    className={s.btnSecondary}
                    disabled={preview}
                    onClick={() => keyFileRef.current?.click()}
                  >
                    选择文件
                  </button>
                  <span className={s.fieldHint}>{privateKeyName !== '' ? privateKeyName : '未选择'}</span>
                </div>
                <input
                  ref={keyFileRef}
                  type="file"
                  hidden
                  aria-label="私钥文件"
                  onChange={(event) => onKeyFile(event.target.files?.[0])}
                />
              </div>
              <div className={s.formField}>
                <label className={s.fieldLabel} htmlFor="conn-passphrase">私钥口令(可空)</label>
                <input
                  id="conn-passphrase"
                  className={s.input}
                  type="password"
                  value={passphrase}
                  disabled={preview}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </div>
            </>
          )}
          {hasDatabase && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-database">数据库(可空)</label>
              <input
                id="conn-database"
                className={s.input}
                value={database}
                disabled={preview}
                placeholder={kind === 'postgresql' ? 'postgres' : ''}
                onChange={(event) => setDatabase(event.target.value)}
              />
            </div>
          )}
          {kind === 'redis' && (
            <div className={s.formField}>
              <label className={s.fieldLabel} htmlFor="conn-redis-db">DB 索引</label>
              <input
                id="conn-redis-db"
                className={s.input}
                type="number"
                value={redisDb}
                disabled={preview}
                onChange={(event) => setRedisDb(Number(event.target.value) || 0)}
              />
            </div>
          )}
          {isDb && (
            <div className={s.formField}>
              <span className={s.fieldLabel}>SSL</span>
              <label className={s.fieldHint}>
                <input
                  type="checkbox"
                  checked={ssl}
                  disabled={preview}
                  onChange={(event) => setSsl(event.target.checked)}
                />
                {' '}使用 SSL/TLS 连接
              </label>
            </div>
          )}
        </div>
        {error !== '' && <div className={s.errorText}>{error}</div>}
        <div className={s.actionRow}>
          {editing && (
            <button
              type="button"
              className={s.btnDanger}
              disabled={preview || busy}
              onClick={() => void onDelete()}
            >
              {confirmingDelete ? '确认删除?' : '删除连接'}
            </button>
          )}
          <span className={s.spacer} />
          <button type="button" className={s.btnSecondary} disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className={s.btn} disabled={!canSubmit} onClick={() => void onSubmit()}>
            {busy ? '保存中…' : editing ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
