/**
 * dsh 设置面板的 StarHub 分区(设置融入底部设置齿轮):整页 embed StarHub
 * 设置,可见 tab 去掉资产/外观(资产经侧栏工具区「新建连接」管理,外观由
 * dsh 主题设置负责),落地 AI 助手 tab;chrome=inline 隐藏 embed 页自带的
 * 关闭钮(关闭由 dsh 对话框负责)。
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the 'settings.section' SlotMap row (declared by ui-settings).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SETTINGS_SECTION_TABS, settingsEmbedUrl } from './sections.ts'
import css from './StarHubSettingsSection.module.css'

/** Full composed props: the section owner share only (close is unused — the dialog owns it). */
export type StarHubSettingsSectionProps = PropsRuntime<'settings.section'>

/** 分区 iframe 的 src(常量:渲染期不重算,避免 iframe 重载)。 */
const SECTION_URL = settingsEmbedUrl(SETTINGS_SECTION_TABS, 'ai', 'inline')

/**
 * Render the StarHub settings section inside the dsh settings dialog: a
 * full-height embed iframe of the StarHub settings page.
 * @returns the iframe surface filling the section content area.
 */
export function StarHubSettingsSection() {
  return (
    <iframe
      className={css.frame}
      title="StarHub 设置"
      src={SECTION_URL}
    />
  )
}
