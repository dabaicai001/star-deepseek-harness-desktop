/**
 * StarHub 壳级资产 store(Phase 0 spike,Step 1)。
 *
 * 与 client-nav 的 nav store 同一个模式:apply 里 create 一个 handle,多个
 * register 共享身份。conversation.view 是 session scope,框架按
 * handle × scopeKey(sessionId)缓存实例 —— 所以「资产列表」这种全局数据
 * 放 per-session 实例会随会话切换重建(这正是 D2 要记录的实验证据);
 * 长生命周期状态(连接句柄)最终应提升到 root-scope 承载,见方案文档 D2。
 */
import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'

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

type StarHubAssetState = {
  /** 最近一次 get_assets 的结果(可能为空)。 */
  assets: readonly RustAsset[]
  /** 拉取中(组件据此展示 loading,避免重复拉取)。 */
  loading: boolean
  /** 最近一次拉取的错误;null = 无错误。 */
  error: string | null
}

type StarHubAssetActions = {
  setAssets: (draft: StarHubAssetState, assets: readonly RustAsset[]) => void
  setLoading: (draft: StarHubAssetState, loading: boolean) => void
  setError: (draft: StarHubAssetState, error: string | null) => void
}

/**
 * 资产 store 工厂:init 给空清单,actions 只承载「拉取结果」写入。
 * @returns 共享 store handle(apply 闭包里 create,注册时传给 register)。
 */
export function createStarHubAssetStore() {
  return defineStore<StarHubAssetState, StarHubAssetActions>({
    init: (): StarHubAssetState => ({ assets: [], loading: false, error: null }),
    actions: {
      setAssets: (d, assets) => { d.assets = assets },
      setLoading: (d, loading) => { d.loading = loading },
      setError: (d, error) => { d.error = error },
    },
  })
}
