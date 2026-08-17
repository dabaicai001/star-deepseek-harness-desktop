/**
 * 资产 → 路由/tab 的单一入口。
 * 历史:routeNameForAsset / openAssetTab / getDbLabel 曾在 AssetTree.vue、
 * CyberLayout.vue、CommandPalette.vue 重复三份,此处收敛。
 */
import type { Router } from 'vue-router'
import type { Asset } from '@/types/asset'
import { generateInstanceId } from '@/utils/tabId'
import { useAppStore } from '@/stores/app'
import { useAssetStore } from '@/stores/asset'

/** 资产 → 路由名(kafka/nsq 共用 db-broker;未知 dbType 回退 db-mysql;excel 已随工作簿功能退役) */
export function routeNameForAsset(asset: Asset): string {
  if (asset.type === 'ssh') return 'ssh-terminal'
  if (asset.type === 'docker') return 'docker'
  if (asset.type === 'local') return 'local'
  const dbType = asset.config.dbType || 'mysql'
  if (dbType === 'redis') return 'db-redis'
  if (dbType === 'elasticsearch') return 'db-elasticsearch'
  if (dbType === 'clickhouse') return 'db-clickhouse'
  if (dbType === 'postgresql') return 'db-postgresql'
  if (dbType === 'kafka' || dbType === 'nsq') return 'db-broker'
  return 'db-mysql'
}

/** dbType → 侧栏等宽小徽章文案(>5 字符的一律缩写,避免溢出 64px 徽章) */
export function getDbLabel(dbType?: string): string {
  switch (dbType) {
    case 'redis': return 'REDIS'
    case 'postgresql': return 'PG'
    case 'sqlite': return 'SQLT'
    case 'elasticsearch': return 'ES'
    case 'clickhouse': return 'CH'
    case 'mssql': return 'MSSQL'
    case 'kafka': return 'KAFKA'
    case 'nsq': return 'NSQ'
    case 'mysql':
    default: return 'MYSQL'
  }
}

/**
 * 打开资产 tab。reuseExisting=true 时复用该资产已有 tab 并激活;
 * 返回 tab 的 instanceId。sidebar 折叠时先展开。
 */
export function openAssetTab(asset: Asset, reuseExisting: boolean, router: Router): string {
  const appStore = useAppStore()
  const assetStore = useAssetStore()
  if (!appStore.sidebarOpen) appStore.sidebarOpen = true
  if (reuseExisting) {
    const existing = appStore.tabs.find(t => t.assetId === asset.id)
    if (existing) {
      appStore.setActiveTab(existing.id)
      router.push({ name: routeNameForAsset(asset), params: { id: existing.id } })
      assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
      return existing.id
    }
  }
  const instanceId = generateInstanceId(asset.id)
  appStore.addTab({ id: instanceId, assetId: asset.id, title: asset.name, type: asset.type })
  assetStore.updateAsset(asset.id, { lastUsedAt: Date.now() })
  router.push({ name: routeNameForAsset(asset), params: { id: instanceId } })
  return instanceId
}

/** 派发对象选中事件(资产树对象节点 → 各域视图) */
export function dispatchObjectSelection(assetId: string, kind: string, payload: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('starhub:object-selected', { detail: { assetId, kind, payload } }))
}
