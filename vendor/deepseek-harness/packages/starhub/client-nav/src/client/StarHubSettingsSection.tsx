/**
 * dsh 设置面板的 StarHub 分区(设置融入底部设置齿轮):壳内 React 设置面板
 * (迁移手册 §3.2 Settings 特例),不再 embed iframe。通用/外观由 dsh 设置
 * 接管,资产 tab 走工具区连接管理 overlay。
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'settings.section' SlotMap row (declared by ui-settings).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { StarHubSettingsPanel } from './settings/SettingsPanel.tsx'

/** Full composed props: the section owner share only (close is unused — the dialog owns it). */
export type StarHubSettingsSectionProps = PropsRuntime<'settings.section'>

/**
 * Render the StarHub settings section inside the dsh settings dialog: the
 * tabbed React settings panel filling the section content area.
 * @returns the in-shell settings surface.
 */
export function StarHubSettingsSection() {
  return <StarHubSettingsPanel />
}
