import { invoke } from '@tauri-apps/api/core'

export interface Asset {
  id: number
  name: string
  type: string
  created_at: string
  updated_at: string
}

export async function getAssets(): Promise<Asset[]> {
  return await invoke('get_assets')
}

export async function createAsset(name: string, type: string): Promise<Asset> {
  return await invoke('create_asset', { name, type })
}

export async function updateAsset(id: number, name: string, type: string): Promise<Asset> {
  return await invoke('update_asset', { id, name, type })
}

export async function deleteAsset(id: number): Promise<void> {
  return await invoke('delete_asset', { id })
}
