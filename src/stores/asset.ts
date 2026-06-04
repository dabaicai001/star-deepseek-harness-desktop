import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Asset, AssetGroup, CreateAssetDto, UpdateAssetDto } from '@/types/asset'

export const useAssetStore = defineStore('asset', () => {
  const assets = ref<Asset[]>([])
  const groups = ref<AssetGroup[]>([])
  const searchQuery = ref('')

  const filteredAssets = computed(() => {
    if (!searchQuery.value) return assets.value
    const query = searchQuery.value.toLowerCase()
    return assets.value.filter(asset =>
      asset.name.toLowerCase().includes(query) ||
      asset.config.host?.toLowerCase().includes(query) ||
      asset.tags.some(tag => tag.toLowerCase().includes(query))
    )
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
    // TODO: 调用 Tauri IPC 获取资产
    assets.value = []
  }

  async function createAsset(dto: CreateAssetDto): Promise<Asset> {
    const asset: Asset = {
      id: crypto.randomUUID(),
      type: dto.type,
      name: dto.name,
      groupId: dto.groupId || null,
      config: dto.config,
      keyId: null,
      tags: dto.tags || [],
      favorite: false,
      lastUsedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    assets.value.push(asset)
    return asset
  }

  async function updateAsset(id: string, dto: UpdateAssetDto) {
    const index = assets.value.findIndex(a => a.id === id)
    if (index > -1) {
      assets.value[index] = {
        ...assets.value[index],
        ...dto,
        updatedAt: Date.now()
      }
    }
  }

  async function deleteAsset(id: string) {
    assets.value = assets.value.filter(a => a.id !== id)
  }

  function toggleFavorite(id: string) {
    const asset = assets.value.find(a => a.id === id)
    if (asset) {
      asset.favorite = !asset.favorite
    }
  }

  function setSearchQuery(query: string) {
    searchQuery.value = query
  }

  return {
    assets,
    groups,
    searchQuery,
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
  persist: true
})
