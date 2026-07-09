import type { DependencyOverride, IUniverConfig, Plugin, PluginCtor } from '@univerjs/core'
import { IAuthzIoService, IMentionIOService, IUndoRedoService, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { defaultTheme } from '@univerjs/themes'

export type { FUniver } from '@univerjs/core/facade'
export type { Univer } from '@univerjs/core'

export interface UniverPreset {
  plugins: Array<PluginCtor<Plugin> | [PluginCtor<Plugin>, ConstructorParameters<PluginCtor<Plugin>>[0]]>
}

export interface UniverPresetOptions {
  lazy?: boolean
}

export type CreateUniverOptions = Partial<IUniverConfig> & {
  presets: Array<UniverPreset | [UniverPreset, UniverPresetOptions]>
  plugins?: Array<PluginCtor<Plugin> | [PluginCtor<Plugin>, ConstructorParameters<PluginCtor<Plugin>>[0]]>
  override?: DependencyOverride
  collaboration?: true
}

// Mirrored from vendor/univer-presets/packages/presets/src/umd.ts so StarHub owns the integration seam.
export function createUniver(options: CreateUniverOptions) {
  const { presets, plugins, collaboration, override = [], ...univerOptions } = options

  if (collaboration) {
    override.push([IUndoRedoService, null])
    override.push([IAuthzIoService, null])
    override.push([IMentionIOService, null])
  }

  const univer = new Univer({
    logLevel: LogLevel.WARN,
    ...univerOptions,
    override,
  })

  const pluginsMap = new Map<string, {
    plugin: PluginCtor<Plugin>
    options?: ConstructorParameters<PluginCtor<Plugin>>[0]
  }>()

  presets.forEach((preset) => {
    const realPreset = Array.isArray(preset) ? preset[0] : preset
    realPreset.plugins.forEach((pluginEntry) => {
      const [realPlugin, pluginConfig] = Array.isArray(pluginEntry)
        ? [pluginEntry[0], pluginEntry[1]]
        : [pluginEntry, undefined]

      if (pluginsMap.has(realPlugin.pluginName)) {
        pluginsMap.delete(realPlugin.pluginName)
      }
      pluginsMap.set(realPlugin.pluginName, { plugin: realPlugin, options: pluginConfig })
    })
  })

  plugins?.forEach((pluginEntry) => {
    const [realPlugin, pluginConfig] = Array.isArray(pluginEntry)
      ? [pluginEntry[0], pluginEntry[1]]
      : [pluginEntry, undefined]

    if (pluginsMap.has(realPlugin.pluginName)) {
      throw new Error(`Plugin ${realPlugin.pluginName} already registered by presets or other ways.`)
    }
    pluginsMap.set(realPlugin.pluginName, { plugin: realPlugin, options: pluginConfig })
  })

  pluginsMap.forEach(({ plugin, options }) => {
    univer.registerPlugin(plugin, options)
  })

  return {
    univer,
    univerAPI: FUniver.newAPI(univer),
  }
}

export function mergeLocales<T extends Record<string, unknown>>(...locales: T[]): T {
  return locales.reduce<T>((merged, locale) => ({
    ...merged,
    ...locale,
  }), {} as T)
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** 将 StarHub token 映射到 Univer canvas 主题。 */
export function buildStarhubTheme(mode: 'excel' | 'system' = 'excel') {
  const isSystem = mode === 'system'
  const gridBg = cssVar(isSystem ? '--panel-solid' : '--excel-grid-bg', isSystem ? '#101822' : '#ffffff')
  const ribbonBg = cssVar(isSystem ? '--panel-solid-2' : '--excel-ribbon-bg', isSystem ? '#152032' : '#f3f2f1')
  const line = cssVar(isSystem ? '--line-2' : '--excel-grid-line', isSystem ? '#283848' : '#e1dfdd')
  const text = cssVar(isSystem ? '--text' : '--excel-text', isSystem ? '#dce7f3' : '#201f1e')
  const muted = cssVar(isSystem ? '--text-2' : '--excel-muted', isSystem ? '#9aa8ba' : '#605e5c')
  const primary = cssVar(isSystem ? '--cyan' : '--excel-green', isSystem ? '#5dd6d6' : '#107c41')

  return {
    ...defaultTheme,
    primaryColor: primary,
    gray: {
      ...defaultTheme.gray,
      50: gridBg,
      100: ribbonBg,
      200: line,
      700: muted,
      800: text,
      900: text,
    },
  }
}
