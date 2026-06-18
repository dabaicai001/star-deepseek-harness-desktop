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

export async function fetchAssets(): Promise<Asset[]> {
  if (!isTauriRuntime()) return []
  const raw = await invoke<RustAsset[]>('get_assets')
  return raw.map(fromRustAsset)
}

export async function createAsset(dto: CreateAssetDto): Promise<Asset> {
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
  await invoke('delete_asset', { id })
}

export async function toggleAssetFavorite(id: string): Promise<Asset> {
  const raw = await invoke<RustAsset>('toggle_asset_favorite', { id })
  return fromRustAsset(raw)
}
