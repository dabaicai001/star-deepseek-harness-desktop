import { computed, onBeforeUnmount, ref, watch } from 'vue'

export function usePersistentPanelState(scope: string, defaultOpen = true) {
  const key = `starhub.panel.${scope}.open`
  const state = ref(defaultOpen)

  try {
    const raw = localStorage.getItem(key)
    if (raw === 'true' || raw === 'false') state.value = raw === 'true'
  } catch {}

  watch(state, (value) => {
    try { localStorage.setItem(key, String(value)) } catch {}
  })

  // 跨 tab / 窗口同步:其他页面写入同 key 时更新本地 ref。
  // 注意 storage 事件只在「其他」标签页触发,本页写入仍走上面的 watch,
  // 因此不会因回写造成循环;纯浏览器 dev / SSR 下 window 可能不存在,直接跳过。
  function onStorage(event: StorageEvent) {
    if (event.key !== key) return
    if (event.newValue === 'true' || event.newValue === 'false') {
      state.value = event.newValue === 'true'
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    onBeforeUnmount(() => window.removeEventListener('storage', onStorage))
  }

  return computed({
    get: () => state.value,
    set: (value: boolean) => { state.value = value }
  })
}
