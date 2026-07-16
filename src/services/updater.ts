import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export interface UpdateInfo {
  available: boolean
  version?: string
  date?: string
  body?: string
}

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 检查是否有可用更新;纯浏览器预览降级返回无更新 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  if (!isTauriEnvironment()) {
    return { available: false }
  }
  const update = await check()
  if (update) {
    return {
      available: true,
      version: update.version,
      date: update.date ?? undefined,
      body: update.body ?? undefined,
    }
  }
  return { available: false }
}

/** 下载并安装更新,安装完成后自动重启;纯浏览器预览直接返回 */
export async function downloadAndInstall(): Promise<void> {
  if (!isTauriEnvironment()) {
    return
  }
  const update = await check()
  if (!update) return
  await update.downloadAndInstall()
  await relaunch()
}
