/**
 * Settings AI 助手 tab(React 壳内版,只做 dsh 未接管的两块)——自
 * SettingsView.vue 迁移:命令白名单(05)+ 记忆管理(06,含记忆管理弹窗)。
 * 模型/MCP/技能/上下文预算/迭代步数/压缩阈值由 dsh harness 接管,不做。
 * 记忆 4 开关直接写 localStorage 即时持久化(与 Vue aiStore.updateSettings
 * 直写语义一致);白名单经保存按钮落盘。
 */
import { useEffect, useMemo, useState } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  aiMemoryDelete, aiMemoryList, aiMemoryUpdate, isTauriRuntime, logAudit,
  type AiMemoryRow,
} from './services.ts'
import { loadAiSettings, saveAiSettings, type AiSettings } from './aiSettings.ts'
import s from './settings.module.css'

/** 卡容量上限(与 Rust 侧一致:user/asset=1375,global=2200)。 */
function memoryScopeLimit(scope: string): number {
  return scope === 'global' ? 2200 : 1375
}

/** scope 展示文案(user/global/asset:{id})。 */
function memoryScopeLabel(scope: string): string {
  if (scope === 'user') return 'USER — 用户画像'
  if (scope === 'global') return 'GLOBAL — 环境与经验'
  return `ASSET — ${scope.slice('asset:'.length)}`
}

/**
 * 渲染 AI 助手设置:命令白名单 + 记忆与上下文(即时生效)+ 记忆管理弹窗。
 * @returns AI tab 内容。
 */
export function AiTab() {
  const [aiSettings, setAiSettings] = useState<AiSettings>(loadAiSettings)
  const [newWhitelistItem, setNewWhitelistItem] = useState('')
  const [whitelistSaved, setWhitelistSaved] = useState(false)

  // 记忆管理弹窗
  const [memoryDialog, setMemoryDialog] = useState(false)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryRows, setMemoryRows] = useState<AiMemoryRow[]>([])
  const [memoryError, setMemoryError] = useState('')
  const [memoryEditingId, setMemoryEditingId] = useState('')
  const [memoryEditingContent, setMemoryEditingContent] = useState('')
  const [memoryConfirmDeleteId, setMemoryConfirmDeleteId] = useState('')
  const memoryDesktopAvailable = isTauriRuntime()

  // 归一化结果持久化一次(白名单 v3 迁移等,与 Vue ensureSettingsShape 落盘一致)
  useEffect(() => {
    saveAiSettings(aiSettings)
  }, [aiSettings])

  /** 记忆/上下文字段:直接写 localStorage 即时持久化。 */
  const updateSettings = (patch: Partial<AiSettings>) => {
    setAiSettings((current) => ({ ...current, ...patch }))
  }

  const onSaveWhitelist = () => {
    updateSettings({ commandWhitelist: aiSettings.commandWhitelist })
    setWhitelistSaved(true)
    setTimeout(() => { setWhitelistSaved(false) }, 1600)
  }

  const addWhitelist = () => {
    const cmd = newWhitelistItem.trim()
    if (cmd === '') return
    if (!aiSettings.commandWhitelist.includes(cmd)) {
      updateSettings({ commandWhitelist: [...aiSettings.commandWhitelist, cmd] })
    }
    setNewWhitelistItem('')
  }

  const removeWhitelist = (cmd: string) => {
    updateSettings({ commandWhitelist: aiSettings.commandWhitelist.filter((item) => item !== cmd) })
  }

  const loadMemories = async () => {
    if (!memoryDesktopAvailable) return
    setMemoryLoading(true)
    setMemoryError('')
    try {
      setMemoryRows(await aiMemoryList())
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : String(error))
    } finally {
      setMemoryLoading(false)
    }
  }

  const openMemoryManager = () => {
    setMemoryDialog(true)
    setMemoryEditingId('')
    setMemoryConfirmDeleteId('')
    void loadMemories()
  }

  const startMemoryEdit = (row: AiMemoryRow) => {
    setMemoryEditingId(row.id)
    setMemoryEditingContent(row.content)
    setMemoryConfirmDeleteId('')
  }

  const saveMemoryEdit = async (row: AiMemoryRow) => {
    const content = memoryEditingContent.trim()
    if (content === '') {
      setMemoryError('记忆内容不能为空')
      return
    }
    setMemoryError('')
    try {
      await aiMemoryUpdate(row.id, content)
      setMemoryEditingId('')
      void logAudit({
        category: 'ai', action: 'memory_update', target: row.scope,
        detail: { content: content.slice(0, 200) },
      })
      await loadMemories()
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteMemory = async (row: AiMemoryRow) => {
    setMemoryError('')
    try {
      await aiMemoryDelete(row.id)
      setMemoryConfirmDeleteId('')
      void logAudit({
        category: 'ai', action: 'memory_remove', target: row.scope,
        detail: { content: row.content.slice(0, 200) },
      })
      await loadMemories()
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : String(error))
    }
  }

  const memoryGroups = useMemo(() => {
    const groups = new Map<string, AiMemoryRow[]>()
    for (const row of memoryRows) {
      const list = groups.get(row.scope) ?? []
      list.push(row)
      groups.set(row.scope, list)
    }
    const order = (scope: string) => (scope === 'user' ? 0 : scope === 'global' ? 1 : 2)
    return Array.from(groups.entries())
      .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
      .map(([scope, rows]) => ({
        scope,
        rows,
        usedChars: rows.map((row) => row.content).join('\n§\n').length,
        limit: memoryScopeLimit(scope),
      }))
  }, [memoryRows])

  return (
    <div className={s.panel}>
      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionNumber}>05</span>
          <span className={s.sectionTitle}>命令白名单</span>
          <span className={s.sectionDesc}>匹配的命令前缀不再弹确认对话框</span>
        </div>
        <div className={s.toolbar}>
          <input
            className={s.input} placeholder="输入命令前缀,回车添加"
            value={newWhitelistItem}
            onChange={(event) => setNewWhitelistItem(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') addWhitelist() }}
          />
          <button type="button" className={s.btnSecondary} onClick={addWhitelist}>添加</button>
          <button type="button" className={s.btn} onClick={onSaveWhitelist}>保存</button>
          {whitelistSaved && <span className={s.resultText}>已保存</span>}
        </div>
        <div className={s.whitelistGrid}>
          {aiSettings.commandWhitelist.map((cmd) => (
            <span key={cmd} className={s.whitelistChip}>
              <code className={s.mono}>{cmd}</code>
              <button
                type="button" className={s.chipRemove} aria-label={`移除 ${cmd}`}
                onClick={() => removeWhitelist(cmd)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className={s.section}>
        <div className={s.sectionHeader}>
          <span className={s.sectionNumber}>06</span>
          <span className={s.sectionTitle}>记忆与上下文</span>
          <span className={s.spacer} />
          <button type="button" className={s.btnSecondary} onClick={openMemoryManager}>管理记忆</button>
        </div>
        <div className={s.formGrid}>
          <label className={s.checkboxRow}>
            <input
              type="checkbox" checked={aiSettings.memoryStoreToolOutputs}
              onChange={(event) => updateSettings({ memoryStoreToolOutputs: event.target.checked })}
            />
            存档 tool 消息与工具调用
          </label>
          <label className={s.checkboxRow}>
            <input
              type="checkbox" checked={aiSettings.memoryEnabled}
              onChange={(event) => updateSettings({ memoryEnabled: event.target.checked })}
            />
            启用长期记忆
          </label>
          <label className={s.checkboxRow}>
            <input
              type="checkbox" checked={aiSettings.memoryWriteNeedsConfirm}
              onChange={(event) => updateSettings({ memoryWriteNeedsConfirm: event.target.checked })}
            />
            记忆写入需逐条确认
          </label>
          <label className={s.checkboxRow}>
            <input
              type="checkbox" checked={aiSettings.memoryAutoReview}
              onChange={(event) => updateSettings({ memoryAutoReview: event.target.checked })}
            />
            自动沉淀记忆
          </label>
        </div>
      </div>

      {memoryDialog && (
        <div className={s.dialogBackdrop} role="presentation" onMouseDown={() => setMemoryDialog(false)}>
          <div
            className={s.dialogPanel}
            role="dialog"
            aria-label="长期记忆管理"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className={s.dialogHead}>
              <span className={s.dialogTitle}>长期记忆管理</span>
              <button
                type="button" className={s.iconButton} aria-label="刷新"
                disabled={memoryLoading} onClick={() => void loadMemories()}
              >
                {memoryLoading ? '…' : '↻'}
              </button>
              <button type="button" className={s.iconButton} aria-label="关闭" onClick={() => setMemoryDialog(false)}>
                <IconCloseOutline16 size={14} />
              </button>
            </div>
            {memoryError !== '' && <div className={s.errorText}>{memoryError}</div>}
            {!memoryDesktopAvailable && (
              <div className={s.empty}>记忆功能仅在 StarHub 桌面端可用。</div>
            )}
            {memoryDesktopAvailable && memoryGroups.length === 0 && (
              <div className={s.empty}>暂无记忆条目。</div>
            )}
            <div className={s.memoryGroups}>
              {memoryGroups.map((group) => (
                <div key={group.scope} className={s.memoryGroup}>
                  <div className={s.memoryGroupHeader}>
                    <span className={s.cardName}>{memoryScopeLabel(group.scope)}</span>
                    <span className={`${s.mono} ${s.hint} ${group.usedChars >= group.limit ? s.memoryFull : ''}`}>
                      {group.usedChars}/{group.limit} 字符
                    </span>
                  </div>
                  {group.rows.map((row) => (
                    <div key={row.id} className={s.memoryItem}>
                      {memoryEditingId === row.id ? (
                        <>
                          <textarea
                            className={s.textarea} value={memoryEditingContent}
                            onChange={(event) => setMemoryEditingContent(event.target.value)}
                          />
                          <div className={s.actionRow}>
                            <button
                              type="button" className={s.btnSecondary}
                              onClick={() => setMemoryEditingId('')}
                            >
                              取消
                            </button>
                            <button
                              type="button" className={s.btn}
                              onClick={() => void saveMemoryEdit(row)}
                            >
                              保存
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className={s.memoryContent}>{row.content}</span>
                          <span className={s.cardActions}>
                            <button
                              type="button" className={s.iconButton} title="编辑" aria-label="编辑"
                              onClick={() => startMemoryEdit(row)}
                            >
                              ✎
                            </button>
                            <button
                              type="button" className={s.iconButton} title="删除" aria-label="删除"
                              onClick={() => setMemoryConfirmDeleteId(row.id)}
                            >
                              <IconCloseOutline16 size={13} />
                            </button>
                          </span>
                        </>
                      )}
                      {memoryConfirmDeleteId === row.id && (
                        <div className={s.actionRow}>
                          <span className={s.hint}>确认删除这条记忆?</span>
                          <button
                            type="button" className={s.btnSecondary}
                            onClick={() => setMemoryConfirmDeleteId('')}
                          >
                            取消
                          </button>
                          <button
                            type="button" className={s.btnDanger}
                            onClick={() => void deleteMemory(row)}
                          >
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
