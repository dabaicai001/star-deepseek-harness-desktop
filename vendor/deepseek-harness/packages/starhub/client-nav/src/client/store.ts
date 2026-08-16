/**
 * StarHub 壳级导航 + 资产状态(P1 方案)。
 *
 * 状态按 scope 拆成三份,因为 dsh 的 store handle 有 one-handle-one-scope
 * 约束(共享 handle 首次挂载即钉死 scope,跨 scope 复用直接抛错),且
 * session-maybe 席位在无会话时不挂注册侧 store(useStore 不下发):
 * - `createStarHubNavStore`(root scope):侧栏大类展开态 + 旧扁平条目,
 *   挂在 sidebar.navigation / shell.overlay(均 root scope)上共享;
 * - `createStarHubAssets`:资产列表(get_assets 结果)与拉取状态。两座
 *   工作区席位(workspace 无会话 / details.workspace 有会话)在无会话分支
 *   拿不到注册侧 store,故资产状态由 apply 持有的裸 source 经 inject
 *   hooks 舱位下发、经 refresh 回调驱动(同 ui-agent-preset 的 controller 范式);
 * - `createToolSelectionBridge`:跨 scope 的「当前子类 + 打开的资产实例」。
 *   选择状态必须跨 root(nav 点击)与 session-maybe(工作区列表/overlay
 *   读)两个 scope,同样走 apply 持有的裸 source + 注入回调。
 */
import {
  createSnapshotStore, defineStore, type EngineStoreHandle, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { routePrefixForAsset, STARHUB_SUBCATEGORIES, type StarHubAsset } from './sections.ts'

/** Rust get_assets 返回的 Asset 序列化形态(与 src-tauri/src/commands/asset.rs 一致)。 */
export interface RustAsset {
  id: string
  type: string
  name: string
  group_id: number | null
  config: Record<string, unknown>
  key_id: string | null
  tags: string[]
  favorite: boolean
  last_used_at: number | null
  created_at: number
  updated_at: number
}

/** 壳内导航状态(root scope):大类展开 + 旧扁平条目。 */
type StarHubNavState = {
  /** 「工具」大类是否展开(侧栏)。 */
  categoryOpen: boolean
  /** 当前打开的功能页 key(旧扁平条目,如 settings);null = 关闭。 */
  active: string | null
}

/** 导航写集合。 */
type StarHubNavActions = {
  toggleCategory: (draft: StarHubNavState) => void
  toggleSection: (draft: StarHubNavState, key: string) => void
  openSection: (draft: StarHubNavState, key: string) => void
  closeSection: (draft: StarHubNavState) => void
}

/**
 * Create the root-scope navigation store handle (sidebar.navigation +
 * shell.overlay share it; both seats are root scope).
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createStarHubNavStore(): EngineStoreHandle<StarHubNavState, StarHubNavActions> {
  return defineStore({
    init: (): StarHubNavState => ({ categoryOpen: true, active: null }),
    actions: {
      toggleCategory: (d) => { d.categoryOpen = !d.categoryOpen },
      toggleSection: (d, key: string) => { d.active = d.active === key ? null : key },
      openSection: (d, key: string) => { d.active = key },
      closeSection: (d) => { d.active = null },
    },
  })
}

/** 资产列表状态:get_assets 结果与拉取状态。 */
export interface StarHubAssetListState {
  /** 最近一次 get_assets 的结果(可能为空)。 */
  assets: readonly RustAsset[]
  /** 拉取中(组件据此展示 loading;refresh 期间忽略重复触发)。 */
  loading: boolean
  /** 最近一次拉取的错误;null = 无错误。 */
  error: string | null
}

/** Tauri IPC surface injected into the top frame by the desktop shell. */
interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

/** 顶层帧 Tauri IPC 直调;浏览器预览(无 Tauri)时 reject。 */
function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals === undefined) {
    return Promise.reject(new Error('Tauri IPC unavailable (browser preview)'))
  }
  return internals.invoke(cmd, args) as Promise<T>
}

/**
 * 资产列表 holder:apply 持有的裸 source + refresh 回调。session-maybe 席位
 * 在无会话时框架不挂注册侧 store,资产状态因此不走 defineStore;组件在
 * 挂载与切换子类时调 refresh(每次都拉,保证设置里新建/删除连接后列表新鲜)。
 */
export interface StarHubAssets {
  /** 注入 hooks 舱位的裸 observable。 */
  source: SnapshotStore<StarHubAssetListState>
  /** 重新拉取资产列表(拉取中重复调用会被忽略)。 */
  refresh: () => void
}

/**
 * Create the apply-owned asset list holder.
 * @returns the holder (bare source + refresh callback).
 */
export function createStarHubAssets(): StarHubAssets {
  const source = createSnapshotStore<StarHubAssetListState>({ assets: [], loading: false, error: null })
  const refresh = (): void => {
    if (source.getSnapshot().loading) return
    source.update((d) => { d.loading = true; d.error = null })
    tauriInvoke<RustAsset[]>('get_assets')
      .then((list) => { source.update((d) => { d.assets = list; d.loading = false }) })
      .catch((e: unknown) => {
        source.update((d) => {
          d.error = e instanceof Error ? e.message : String(e)
          d.loading = false
        })
      })
  }
  return { source, refresh }
}

/** 跨 scope 的当前工具选择:子类 + 打开的资产实例(含派生好的路由前缀)。 */
export interface ToolSelection {
  /** 当前选中的子类 key(STARHUB_SUBCATEGORIES[].key);null = 未选。 */
  subcategory: string | null
  /** 当前打开操作页的资产 id;null = 未打开。 */
  assetId: string | null
  /** 打开动作生成一次的实例 id(`<assetId>__<timestamp>`);null = 未打开。 */
  instanceId: string | null
  /** 实例路由前缀(打开时按 routePrefixForAsset 派生);null = 未打开。 */
  routePrefix: string | null
}

/**
 * 选择桥:apply 持有的裸 observable + 写入回调。选择状态跨 root 与
 * session-maybe 两个 scope(one-handle-one-scope 禁止共享 store handle
 * 跨 scope 挂载),故不走注册侧 store;各注册经 inject hooks 舱位拿到
 * 同一 source(绑定按 source 缓存,身份必须稳定),写入一律经回调。
 */
export interface ToolSelectionBridge {
  /** 注入 hooks 舱位的裸 observable(身份与快照引用在变化前保持稳定)。 */
  source: SnapshotStore<ToolSelection>
  /** 选中子类(侧栏点击;不影响已打开的资产实例)。 */
  selectSubcategory: (key: string) => void
  /** 打开资产实例操作页:按资产类型派生路由前缀,并生成一次 instanceId。 */
  openAsset: (asset: StarHubAsset) => void
  /** 关闭当前资产实例操作页(保留子类选择)。 */
  closeAsset: () => void
}

/**
 * Create the cross-scope tool-selection bridge.
 * @returns the bridge (bare source + write callbacks).
 */
export function createToolSelectionBridge(): ToolSelectionBridge {
  const source = createSnapshotStore<ToolSelection>({
    subcategory: null,
    assetId: null,
    instanceId: null,
    routePrefix: null,
  })
  return {
    source,
    selectSubcategory: (key) => { source.update((d) => { d.subcategory = key }) },
    openAsset: (asset) => {
      const prefix = routePrefixForAsset(asset)
        ?? STARHUB_SUBCATEGORIES.find((s) => s.key === source.getSnapshot().subcategory)?.routePrefix
        ?? null
      // 无功能路由的资产类型(如 local):不打开,保持现状
      if (prefix === null) return
      source.set({
        ...source.getSnapshot(),
        assetId: asset.id,
        instanceId: `${asset.id}__${Date.now()}`,
        routePrefix: prefix,
      })
    },
    closeAsset: () => {
      source.update((d) => { d.assetId = null; d.instanceId = null; d.routePrefix = null })
    },
  }
}
