import { computed, ref, watch } from 'vue'

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

  return computed({
    get: () => state.value,
    set: (value: boolean) => { state.value = value }
  })
}
