/**
 * 沙箱桌面工作面板(工具面板「沙箱桌面」子类):实例卡片(直播/接管独立窗口、
 * 停止/恢复/销毁、回放)+ 模板管理(配方 TOML 编辑/新增/删除)。
 *
 * 安全语义(与 Rust desktop 模块一致):直播/接管都开独立 Tauri 窗口全页
 * 加载 noVNC(侧边栏 iframe 尺寸受限且 permissions-policy 禁全屏)。
 * 围观 = noVNC view_only;接管 = 双向 noVNC + 接管互斥(期间 AI 写操作被
 * 拒但不撤销授权),窗口销毁由 Rust 自动释放接管。销毁/停止/恢复走
 * desktop_ui_lifecycle(用户按钮即审批表达,不经 AI 工具路径)。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  deleteSandboxTemplate, fetchReplayFrames, fetchSandboxOverview, fileSrc,
  openSandboxLiveWindow, sandboxLifecycle, upsertSandboxTemplate,
  type ReplayFrame, type SandboxInstance, type SandboxOverview, type SandboxTemplate,
} from './services.ts'
import css from './SandboxPanel.module.css'

/** 默认新模板配方(与 Rust recipe::DEFAULT_RECIPE_TOML 对齐)。 */
const NEW_TEMPLATE_RECIPE = `name = "my-template"
base = "ubuntu:24.04"
memory_mb = 2048
cpus = 2.0
network = "restricted"
resolution = "1920x1080"
install = ["mousepad"]
provision = []
`

/** 沙箱桌面面板:实例 + 模板两栏。 */
export function SandboxPanel() {
  const [overview, setOverview] = useState<SandboxOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [replay, setReplay] = useState<{ sandboxId: string; frames: ReplayFrame[] } | null>(null)
  const [editing, setEditing] = useState<{ name: string; recipe: string; isNew: boolean } | null>(null)
  /** 不可逆操作的确认目标:销毁实例 / 删除模板。非 null 时展示确认弹窗。 */
  const [confirm, setConfirm] = useState<
    | { kind: 'destroy'; instance: SandboxInstance }
    | { kind: 'delete-template'; template: SandboxTemplate }
    | null
  >(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setOverview(await fetchSandboxOverview())
      setError(null)
    } catch (cause) {
      setOverview(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const onLifecycle = async (instance: SandboxInstance, action: 'destroy' | 'pause' | 'resume') => {
    setBusy(`${instance.id}:${action}`)
    try {
      await sandboxLifecycle(instance.id, action)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  // 直播(围观)/接管:都开独立 Tauri 窗口;开窗失败(如浏览器预览无 IPC)上横幅
  const onOpenLive = async (instance: SandboxInstance, takeover: boolean) => {
    try {
      await openSandboxLiveWindow(instance, takeover)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onOpenReplay = async (sandboxId: string) => {
    try {
      setReplay({ sandboxId, frames: await fetchReplayFrames(sandboxId) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const onSaveTemplate = async () => {
    if (editing === null) return
    setBusy('template:save')
    try {
      await upsertSandboxTemplate(editing.name, editing.recipe)
      setEditing(null)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const onDeleteTemplate = async (template: SandboxTemplate) => {
    setBusy(`template:${template.name}`)
    try {
      await deleteSandboxTemplate(template.name)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  /** 确认弹窗的「确认」:按确认目标分发到销毁/删除,先收弹窗再执行。 */
  const onConfirm = async () => {
    if (confirm === null) return
    const target = confirm
    setConfirm(null)
    if (target.kind === 'destroy') await onLifecycle(target.instance, 'destroy')
    else await onDeleteTemplate(target.template)
  }

  if (loading && overview === null) return <div className={css.status}>加载沙箱…</div>
  if (overview === null) {
    return (
      <div className={css.status}>
        <div>沙箱概览不可用:{error ?? '桌面端后端未连接(浏览器预览)'}</div>
        <button type="button" className={css.button} onClick={() => { void refresh() }}>重试</button>
      </div>
    )
  }

  return (
    <div className={css.root}>
      {error !== null && (
        <div className={css.errorBanner} role="alert">
          <span className={css.errorText}>{error}</span>
          <button
            type="button"
            className={css.errorClose}
            aria-label="关闭错误提示"
            onClick={() => { setError(null) }}
          >
            ×
          </button>
        </div>
      )}

      <section className={css.section}>
        <h3 className={css.sectionTitle}>实例({overview.instances.filter(i => i.status !== 'destroyed').length})</h3>
        {overview.instances.filter(i => i.status !== 'destroyed').length === 0 && (
          <div className={css.status}>没有运行中的沙箱。让 AI 调 desktop_create_sandbox 创建。</div>
        )}
        {overview.instances.filter(i => i.status !== 'destroyed').map(instance => (
          <div key={instance.id} className={css.card}>
            <div className={css.cardMain}>
              <span className={css.cardTitle}>{instance.task !== '' ? instance.task : instance.id.slice(0, 8)}</span>
              <span className={css.cardSub}>
                {instance.status} · 平台 {instance.platform} · noVNC :{instance.novncPort}
              </span>
            </div>
            <div className={css.cardActions}>
              <button
                type="button"
                className={css.button}
                onClick={() => { void onOpenLive(instance, false) }}
              >
                直播
              </button>
              {instance.status === 'running' && (
                <button
                  type="button"
                  className={css.button}
                  onClick={() => { void onOpenLive(instance, true) }}
                >
                  接管
                </button>
              )}
              {instance.status === 'running' && (
                <button type="button" className={css.button} disabled={busy !== null} onClick={() => { void onLifecycle(instance, 'pause') }}>停止</button>
              )}
              {instance.status === 'paused' && (
                <button type="button" className={css.button} disabled={busy !== null} onClick={() => { void onLifecycle(instance, 'resume') }}>恢复</button>
              )}
              <button type="button" className={css.button} onClick={() => { void onOpenReplay(instance.id) }}>回放</button>
              <button
                type="button"
                className={`${css.button} ${css.danger}`}
                disabled={busy !== null}
                onClick={() => { setConfirm({ kind: 'destroy', instance }) }}
              >
                销毁
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className={css.section}>
        <h3 className={css.sectionTitle}>
          模板({overview.templates.length})
          <button
            type="button"
            className={css.button}
            onClick={() => { setEditing({ name: 'my-template', recipe: NEW_TEMPLATE_RECIPE, isNew: true }) }}
          >
            新建模板
          </button>
        </h3>
        {overview.templates.map(template => (
          <div key={template.id} className={css.card}>
            <div className={css.cardMain}>
              <span className={css.cardTitle}>{template.name}</span>
              <span className={css.cardSub}>{template.imageTag !== null ? `镜像 ${template.imageTag}` : '未构建'}</span>
            </div>
            <div className={css.cardActions}>
              <button
                type="button"
                className={css.button}
                onClick={() => { setEditing({ name: template.name, recipe: template.recipe, isNew: false }) }}
              >
                编辑
              </button>
              <button
                type="button"
                className={`${css.button} ${css.danger}`}
                disabled={busy !== null}
                onClick={() => { setConfirm({ kind: 'delete-template', template }) }}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </section>

      {confirm !== null && (
        <div className={css.dialogMask}>
          <div className={css.dialog} role="dialog" aria-label="确认操作">
            <h3 className={css.sectionTitle}>
              {confirm.kind === 'destroy' ? '销毁沙箱' : '删除模板'}
            </h3>
            <div className={css.status}>
              {confirm.kind === 'destroy'
                ? `即将销毁沙箱「${confirm.instance.task !== '' ? confirm.instance.task : confirm.instance.id.slice(0, 8)}」。此操作不可恢复:容器及其中全部数据将被永久删除。`
                : `即将删除模板「${confirm.template.name}」。此操作不可恢复,模板配方将被移除。`}
            </div>
            <div className={css.cardActions}>
              <button
                type="button"
                className={`${css.button} ${css.danger}`}
                disabled={busy !== null}
                onClick={() => { void onConfirm() }}
              >
                {confirm.kind === 'destroy' ? '确认销毁' : '确认删除'}
              </button>
              <button type="button" className={css.button} onClick={() => { setConfirm(null) }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {editing !== null && (
        <div className={css.dialogMask}>
          <div className={css.dialog} role="dialog" aria-label="编辑模板">
            <h3 className={css.sectionTitle}>{editing.isNew ? '新建模板' : `编辑模板 ${editing.name}`}</h3>
            <textarea
              className={css.recipeEditor}
              value={editing.recipe}
              rows={12}
              onChange={event => { setEditing({ ...editing, recipe: event.target.value }) }}
            />
            <div className={css.cardActions}>
              <button type="button" className={css.button} disabled={busy !== null} onClick={() => { void onSaveTemplate() }}>保存</button>
              <button type="button" className={css.button} onClick={() => { setEditing(null) }}>取消</button>
            </div>
          </div>
        </div>
      )}

      {replay !== null && (
        <div className={css.dialogMask}>
          <div className={css.dialog} role="dialog" aria-label="沙箱回放">
            <h3 className={css.sectionTitle}>回放:{replay.sandboxId.slice(0, 8)}({replay.frames.length} 帧)</h3>
            <div className={css.replayList}>
              {replay.frames.length === 0 && <div className={css.status}>该沙箱没有回放帧</div>}
              {replay.frames.map((frame, index) => (
                <div key={index} className={css.replayRow}>
                  <span className={css.cardSub}>
                    #{index + 1} {frame.action} · {new Date(frame.createdAt * 1000).toLocaleTimeString()}
                  </span>
                  {frame.shotPath !== null && fileSrc(frame.shotPath) !== '' && (
                    <img className={css.replayShot} src={fileSrc(frame.shotPath)} alt={`帧 ${index + 1}`} />
                  )}
                </div>
              ))}
            </div>
            <div className={css.cardActions}>
              <button type="button" className={css.button} onClick={() => { setReplay(null) }}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
