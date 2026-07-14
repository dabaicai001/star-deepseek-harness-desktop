import { invoke } from '@tauri-apps/api/core'
import type { Asset, CreateAssetDto, UpdateAssetDto } from '@/types/asset'

interface RustAsset {
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

function fromRustAsset(raw: RustAsset): Asset {
  return {
    id: raw.id,
    type: raw.type as Asset['type'],
    name: raw.name,
    groupId: raw.group_id,
    config: raw.config,
    keyId: raw.key_id,
    tags: raw.tags,
    favorite: raw.favorite,
    lastUsedAt: raw.last_used_at ? raw.last_used_at * 1000 : null,
    createdAt: raw.created_at * 1000,
    updatedAt: raw.updated_at * 1000
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Vite 布局回归没有 Tauri IPC。用页面生命周期内的内存资产承接 CRUD，
// 既能走完整交互，又不会把测试连接写入用户的真实资产库。
const browserAssets: Asset[] = []

export async function fetchAssets(): Promise<Asset[]> {
  if (!isTauriRuntime()) return [...browserAssets]
  const raw = await invoke<RustAsset[]>('get_assets')
  return raw.map(fromRustAsset)
}

export async function createAsset(dto: CreateAssetDto): Promise<Asset> {
  if (!isTauriRuntime()) {
    const now = Date.now()
    const asset: Asset = {
      id: `browser-${crypto.randomUUID()}`,
      type: dto.type,
      name: dto.name,
      groupId: dto.groupId ?? null,
      config: { ...dto.config },
      keyId: null,
      tags: [...(dto.tags ?? [])],
      favorite: false,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    browserAssets.push(asset)
    return asset
  }
  const raw = await invoke<RustAsset>('create_asset', {
    params: {
      type: dto.type,
      name: dto.name,
      group_id: dto.groupId || null,
      config: dto.config,
      tags: dto.tags || []
    }
  })
  return fromRustAsset(raw)
}

export async function updateAsset(id: string, dto: UpdateAssetDto): Promise<Asset> {
  if (!isTauriRuntime()) {
    const index = browserAssets.findIndex(asset => asset.id === id)
    const current = browserAssets[index]
    if (!current) throw new Error(`Asset not found: ${id}`)
    const updated: Asset = {
      ...current,
      name: dto.name ?? current.name,
      groupId: dto.groupId ?? current.groupId,
      config: { ...current.config, ...(dto.config ?? {}) },
      tags: dto.tags ? [...dto.tags] : current.tags,
      favorite: dto.favorite ?? current.favorite,
      lastUsedAt: dto.lastUsedAt ?? current.lastUsedAt,
      updatedAt: Date.now(),
    }
    browserAssets[index] = updated
    return updated
  }
  const raw = await invoke<RustAsset>('update_asset', {
    id,
    params: {
      name: dto.name,
      group_id: dto.groupId,
      config: dto.config,
      tags: dto.tags,
      favorite: dto.favorite,
      last_used_at: dto.lastUsedAt ? Math.floor(dto.lastUsedAt / 1000) : undefined
    }
  })
  return fromRustAsset(raw)
}

export async function deleteAsset(id: string): Promise<void> {
  if (!isTauriRuntime()) {
    const index = browserAssets.findIndex(asset => asset.id === id)
    if (index >= 0) browserAssets.splice(index, 1)
    return
  }
  await invoke('delete_asset', { id })
}

export async function toggleAssetFavorite(id: string): Promise<Asset> {
  if (!isTauriRuntime()) {
    const current = browserAssets.find(asset => asset.id === id)
    if (!current) throw new Error(`Asset not found: ${id}`)
    current.favorite = !current.favorite
    current.updatedAt = Date.now()
    return current
  }
  const raw = await invoke<RustAsset>('toggle_asset_favorite', { id })
  return fromRustAsset(raw)
}
