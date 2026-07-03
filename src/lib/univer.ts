import type { DependencyOverride, IUniverConfig, Plugin, PluginCtor } from '@univerjs/core'
import { IAuthzIoService, IMentionIOService, IUndoRedoService, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'

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
