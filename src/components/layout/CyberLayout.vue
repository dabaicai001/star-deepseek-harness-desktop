<script setup lang="ts">
/**
 * StarHub 功能页布局(dsh 主壳融合 P4a:embed 成为唯一形态)。
 *
 * 旧外壳(自画 titlebar / tab 条 / AssetTree 侧栏 / 状态栏 / 欢迎页 /
 * 命令面板 / 拖出独立窗口)已随 dsh 主壳切换退役——主窗口直接加载
 * dsh web GUI,本组件只运行在 client-nav overlay 的同源 iframe 里:
 * 顶部资产条(EmbedAssetBar)+ router-view + 全局传输任务条。
 *
 * 布局不再区分 embed/非 embed(纯浏览器 dev 预览同样渲染此最简形态);
 * embed 专属行为(入口路由解析、'/' 回退守卫、Esc 转发)由 query 参数驱动,
 * 非 embed 时天然惰性。
 */
import { onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAssetStore } from '@/stores/asset'
import { useTransferStore } from '@/stores/transfer'
import TransferDock from '@/components/transfer/TransferDock.vue'
import EmbedAssetBar from '@/components/common/EmbedAssetBar.vue'
import { embedRoute, resolveEmbedTarget } from '@/lib/embed'

const router = useRouter()
const route = useRoute()
const assetStore = useAssetStore()
const transferStore = useTransferStore()

const embedTarget = embedRoute()
/** embed 模式注册的「禁止回 /」路由守卫的注销函数(onMounted 内安装) */
let removeEmbedGuard: (() => void) | undefined

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

/** iframe 聚焦时 Esc 不透传到 dsh 壳,postMessage 给 client-nav 的 overlay 以关闭功能页 */
function onEmbedKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || isEditableEventTarget(e.target)) return
  if (window.parent === window) return
  window.parent.postMessage({ type: 'starhub-embed-escape' }, window.location.origin)
}

onMounted(async () => {
  // 必须等资产加载完再挂工作区,否则视图误判"资产已被删除"
  await assetStore.fetchAssets().catch((e) => {
    console.warn('[embed] fetchAssets failed:', e)
  })
  transferStore.ensureInit()
  // DbView / DockerView 在资产缺失时会 push('/') 回欢迎页;embed 没有欢迎页,
  // 取消这类回退,让视图停在自己的无资产/未连接空态
  if (embedTarget) {
    removeEmbedGuard = router.beforeEach((to) => to.path !== '/')
    // 段路由(无资产 id,如 /ssh)先解析:有该类型资产 → 带 instanceId 的
    // 功能路由;无资产 → 原样停在段路由的空态页(EmbedSectionEmpty)
    const resolvedTarget = resolveEmbedTarget(embedTarget, assetStore.assets)
    if (route.path !== resolvedTarget) await router.replace(resolvedTarget).catch(() => {})
  }
  window.addEventListener('keydown', onEmbedKeydown)
})

onBeforeUnmount(() => {
  removeEmbedGuard?.()
  window.removeEventListener('keydown', onEmbedKeydown)
})
</script>

<template>
  <div class="embed-layout">
    <EmbedAssetBar />
    <div class="embed-workspace">
      <router-view v-slot="{ Component }">
        <component :is="Component" :key="route.fullPath" />
      </router-view>
    </div>
    <!-- 全局传输任务条:每个功能 iframe 各自挂一份(SFTP 就在该页),互不影响 -->
    <TransferDock />
  </div>
</template>
