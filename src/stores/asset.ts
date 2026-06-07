import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Asset, AssetGroup, CreateAssetDto, UpdateAssetDto } from '@/types/asset'
import * as assetService from '@/services/asset'

export const useAssetStore = defineStore('asset', () => {
  const assets = ref<Asset[]>([])
  const groups = ref<AssetGroup[]>([])
  const searchQuery = ref('')
  const loading = ref(false)

  const filteredAssets = computed(() => {
    if (!searchQuery.value) return assets.value
    const query = searchQuery.value.toLowerCase().trim()
    // 支持 type: 前缀(如 "type:ssh" 或 "type:db")
    let typeFilter: string | null = null
    let textQuery = query
    const typeMatch = query.match(/^type:(\w+)/)
    if (typeMatch) {
      typeFilter = typeMatch[1]
      textQuery = query.replace(typeMatch[0], '').trim()
    }
    return assets.value.filter(asset => {
      if (typeFilter && !asset.type.startsWith(typeFilter)) return false
      if (!textQuery) return true
      const a = asset
      const c = a.config
      // 命中字段:name / host / username / tag / 数据库名 / 类型
      const haystack = [
        a.name,
        c.host,
        c.username,
        c.database,
        c.dbType,
        a.type,
        ...(a.tags || [])
      ].filter((s): s is string => Boolean(s)).map(s => s.toLowerCase())
      return haystack.some(s => s.includes(textQuery))
    })
  })

  const favoriteAssets = computed(() => assets.value.filter(a => a.favorite))

  const assetsByGroup = computed(() => {
    const map = new Map<number | null, Asset[]>()
    for (const asset of filteredAssets.value) {
      const group = asset.groupId
      if (!map.has(group)) map.set(group, [])
      map.get(group)!.push(asset)
    }
    return map
  })

  async function fetchAssets() {
    loading.value = true
    try {
      assets.value = await assetService.fetchAssets()
    } catch (e) {
      console.error('Failed to fetch assets:', e)
    } finally {
      loading.value = false
    }
  }

  async function createAsset(dto: CreateAssetDto): Promise<Asset> {
    const asset = await assetService.createAsset(dto)
    assets.value.push(asset)
    return asset
  }

  async function updateAsset(id: string, dto: UpdateAssetDto) {
    const asset = await assetService.updateAsset(id, dto)
    const index = assets.value.findIndex(a => a.id === id)
    if (index > -1) {
      assets.value[index] = asset
    }
  }

  async function deleteAsset(id: string) {
    await assetService.deleteAsset(id)
    assets.value = assets.value.filter(a => a.id !== id)
  }

  async function toggleFavorite(id: string) {
    const asset = await assetService.toggleAssetFavorite(id)
    const index = assets.value.findIndex(a => a.id === id)
    if (index > -1) {
      assets.value[index] = asset
    }
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query
  }

  return {
    assets,
    groups,
    searchQuery,
    loading,
    filteredAssets,
    favoriteAssets,
    assetsByGroup,
    fetchAssets,
    createAsset,
    updateAsset,
    deleteAsset,
    toggleFavorite,
    setSearchQuery
  }
}, {
  persist: {
    paths: ['searchQuery']
  }
})
