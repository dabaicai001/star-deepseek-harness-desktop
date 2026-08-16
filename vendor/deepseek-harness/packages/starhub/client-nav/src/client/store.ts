/**
 * StarHub 壳级导航 + 资产 store(P1 方案)。
 *
 * 一个共享 handle 承载全部 StarHub 壳内状态:侧栏「工具」大类/子类选择、
 * overlay 打开的功能页与实例、以及资产列表(get_assets 结果)。所有注册
 * (sidebar.navigation / shell.overlay / workspace / details.workspace)经
 * 同一 handle 共享身份,避免多个 store 跨席位传递的复杂度。
 *
 * 注意:workspace / details.workspace 是 session-maybe scope,框架按
 * handle × scopeKey 缓存实例——若挂在不同 scope 会违反 dsh 的
 * one-handle-one-scope 约束,故两处注册都用同一 scope(session-maybe)。
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

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

/** 壳内 StarHub 状态:导航 + 资产。 */
type StarHubState = {
  /** 「工具」大类是否展开(侧栏)。 */
  categoryOpen: boolean
  /** 当前选中的子类 key(STARHUB_SUBCATEGORIES[].key);null = 未选。 */
  activeSubcategory: string | null
  /** 当前打开的功能页 key(旧扁平条目,如 settings);null = 关闭。 */
  active: string | null
  /** 当前打开操作页的资产 id;null = 未打开。 */
  activeAssetId: string | null
  /** 最近一次 get_assets 的结果(可能为空)。 */
  assets: readonly RustAsset[]
  /** 拉取中(组件据此展示 loading,避免重复拉取)。 */
  loading: boolean
  /** 最近一次拉取的错误;null = 无错误。 */
  error: string | null
}

/** 写集合:导航切换 + 资产拉取结果写入。 */
type StarHubActions = {
  toggleCategory: (draft: StarHubState) => void
  setSubcategory: (draft: StarHubState, key: string | null) => void
  toggleSection: (draft: StarHubState, key: string) => void
  openSection: (draft: StarHubState, key: string) => void
  closeSection: (draft: StarHubState) => void
  openAsset: (draft: StarHubState, assetId: string) => void
  closeAsset: (draft: StarHubState) => void
  setAssets: (draft: StarHubState, assets: readonly RustAsset[]) => void
  setLoading: (draft: StarHubState, loading: boolean) => void
  setError: (draft: StarHubState, error: string | null) => void
}

/**
 * Create the shared StarHub store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createStarHubStore(): EngineStoreHandle<StarHubState, StarHubActions> {
  return defineStore({
    init: (): StarHubState => ({
      categoryOpen: true,
      activeSubcategory: null,
      active: null,
      activeAssetId: null,
      assets: [],
      loading: false,
      error: null,
    }),
    actions: {
      toggleCategory: (d) => { d.categoryOpen = !d.categoryOpen },
      setSubcategory: (d, key) => { d.activeSubcategory = key },
      toggleSection: (d, key: string) => { d.active = d.active === key ? null : key },
      openSection: (d, key: string) => { d.active = key },
      closeSection: (d) => { d.active = null },
      openAsset: (d, assetId: string) => { d.activeAssetId = assetId },
      closeAsset: (d) => { d.activeAssetId = null },
      setAssets: (d, assets) => { d.assets = assets },
      setLoading: (d, loading) => { d.loading = loading },
      setError: (d, error) => { d.error = error },
    },
  })
}
