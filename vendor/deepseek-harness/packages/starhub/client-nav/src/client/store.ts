/**
 * StarHub 导航的共享 store:侧栏条目列表与 overlay iframe 层两个注册席位
 * 经同一份 handle 共享「当前打开的功能页」(register 传 handle 而非 factory,
 * 框架按 handle 身份共享实例)。
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** 导航状态:active 为当前打开的功能页 key(SECTIONS[].key),null = 关闭。 */
type StarHubNavState = { active: string | null }

/** 写集合:切换(再点当前条目即关闭)、显式打开(embed 页 postMessage 请求)与显式关闭(Esc / 关闭按钮)。 */
type StarHubNavActions = {
  toggleSection: (draft: StarHubNavState, key: string) => void
  openSection: (draft: StarHubNavState, key: string) => void
  closeSection: (draft: StarHubNavState) => void
}

/**
 * Create the StarHub nav store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createStarHubNavStore(): EngineStoreHandle<StarHubNavState, StarHubNavActions> {
  return defineStore({
    init: (): StarHubNavState => ({ active: null }),
    actions: {
      toggleSection: (d, key: string) => { d.active = d.active === key ? null : key },
      openSection: (d, key: string) => { d.active = key },
      closeSection: (d) => { d.active = null },
    },
  })
}
