/**
 * StarHub 设置面板(React 壳内版):dsh 设置面板 StarHub 分区的内容。
 *
 * 迁移手册 §3.2(Settings 特例):按 tab 逐个 React 化——AI(白名单/记忆,
 * dsh 未接管部分)/ 插件 / 审计 / 告警 / 关于 5 个子项壳内直渲;通用/外观
 * 由 dsh 设置接管,资产 tab 走工具区连接管理 overlay,均不再出现。
 *
 * 导航形态:左侧「StarHub」折叠头,点击展开 5 个子菜单项,再点折叠;
 * 展开时选中项高亮并驱动右侧内容区。
 */
import { useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'settings.section' SlotMap row (declared by ui-settings).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { AiTab } from './ai.tsx'
import { AlertTab } from './alert.tsx'
import { AuditTab } from './audit.tsx'
import { PluginsTab } from './plugins.tsx'
import { AboutTab } from './about.tsx'
import css from './SettingsPanel.module.css'

/** Full composed props: the section owner share only. */
export type StarHubSettingsPanelProps = PropsRuntime<'settings.section'>

/** 已 React 化的设置子项(编号保持全量序列)。 */
export type SettingsTabKey = 'ai' | 'plugins' | 'audit' | 'alert' | 'about'

const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTabKey; num: string; label: string }> = [
  { key: 'ai', num: '04', label: 'AI 助手' },
  { key: 'plugins', num: '05', label: '插件' },
  { key: 'audit', num: '06', label: '审计日志' },
  { key: 'alert', num: '07', label: '告警规则' },
  { key: 'about', num: '08', label: '关于' },
]

/**
 * Render the StarHub settings panel: collapsible "StarHub" menu header above
 * the five submenu rows, driving the active tab's content on the right.
 * @returns the tabbed settings surface filling the section content area.
 */
export function StarHubSettingsPanel() {
  const [menuOpen, setMenuOpen] = useState(true)
  const [activeTab, setActiveTab] = useState<SettingsTabKey>('ai')

  return (
    <div className={css.root}>
      <div className={css.rail} role="navigation" aria-label="StarHub 设置">
        <button
          type="button"
          className={css.railGroup}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <IconChevronDownOutline14
            size={12}
            className={menuOpen ? css.chevronOpen : css.chevron}
          />
          <span className={css.groupLabel}>StarHub</span>
        </button>
        {menuOpen && SETTINGS_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            aria-pressed={activeTab === tab.key}
            className={activeTab === tab.key ? css.railItemActive : css.railItem}
            onClick={() => setActiveTab(tab.key)}
          >
            <span className={css.railNum}>{tab.num}</span>
            <span className={css.railLabel}>{tab.label}</span>
          </button>
        ))}
      </div>
      <div className={css.content}>
        {activeTab === 'ai' && <AiTab />}
        {activeTab === 'plugins' && <PluginsTab />}
        {activeTab === 'audit' && <AuditTab />}
        {activeTab === 'alert' && <AlertTab />}
        {activeTab === 'about' && <AboutTab />}
      </div>
    </div>
  )
}
