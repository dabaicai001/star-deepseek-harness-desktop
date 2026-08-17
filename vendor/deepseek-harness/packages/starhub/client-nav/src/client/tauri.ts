/**
 * Top-frame Tauri IPC bridge for the StarHub client plugin.
 *
 * The desktop shell injects `window.__TAURI_INTERNALS__.invoke` into the top
 * frame (same-origin, P0 spike verified). The client bundle cannot import
 * `@tauri-apps/api`, so every StarHub tool service goes through this thin
 * adapter — the same pattern the browser preview relies on: without Tauri
 * internals the call rejects, and views render their preview/error state.
 */

/** Tauri IPC surface injected into the top frame by the desktop shell. */
interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  /** Callback registry used by the event plugin (present in the real runtime). */
  transformCallback?: (callback: unknown, once?: boolean) => number
}

/**
 * Call a Tauri command through the injected IPC bridge.
 * @param cmd - Rust command name (e.g. `broker_overview`).
 * @param args - command arguments (camelCase keys; Tauri serializes to snake_case).
 * @returns the command result.
 * @throws when running in a plain browser preview (no Tauri internals).
 */
export function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals === undefined) {
    return Promise.reject(new Error('Tauri IPC unavailable (browser preview)'))
  }
  return internals.invoke(cmd, args) as Promise<T>
}

/** Event payload envelope delivered by the Tauri event plugin to listen callbacks. */
interface TauriEventEnvelope<T> {
  event: string
  id: number
  payload: T
}

/** Async disposer returned by a Tauri event subscription. */
export type TauriUnlisten = () => Promise<void>

/**
 * Subscribe to a Tauri event through the event plugin (`plugin:event|listen`),
 * mirroring `@tauri-apps/api/event.listen` over the injected IPC bridge (the
 * client bundle cannot import the api package). The callback registration
 * requires `transformCallback`, which exists in the real desktop runtime;
 * without it (browser preview or stubbed internals) the subscription is a
 * no-op and the returned disposer resolves immediately.
 * @param event - event name (e.g. `ssh:hostkey-confirm:<id>`).
 * @param handler - receives each event payload until disposed.
 * @returns disposer that unlistens from the event plugin.
 */
export async function tauriListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<TauriUnlisten> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  const transform = internals?.transformCallback
  if (internals === undefined || typeof transform !== 'function') {
    return () => Promise.resolve()
  }
  const callbackId = transform((envelope: TauriEventEnvelope<T>) => { handler(envelope.payload) }, false)
  const eventId = await internals.invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: callbackId,
  }) as number
  return async () => {
    await internals.invoke('plugin:event|unlisten', { event, eventId })
  }
}

/**
 * Open a StarHub page in a NEW window instead of overlaying the dsh shell.
 * Desktop: a real Tauri webview window (label must match the capability
 * glob `starhub-*` so the embed page inside keeps its IPC grants). Browser
 * preview: a new tab. The page URL is a same-origin path (e.g. the embed
 * entry `/starhub/index.html?embed=1&route=...`); the Tauri command needs
 * an absolute URL, so it is resolved against the current origin.
 * @param path - same-origin page path (absolute path, not full URL).
 * @param title - new window title (asset name).
 * @returns after the window/tab has been requested.
 * @throws when the desktop window creation IPC fails (no silent fallback —
 *   a failed open must surface, not quietly do nothing).
 */
export async function openNewPage(path: string, title: string): Promise<void> {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  if (internals === undefined) {
    window.open(path, '_blank', 'noopener')
    return
  }
  await internals.invoke('plugin:webview|create_webview_window', {
    options: {
      label: `starhub-page-${Date.now()}`,
      url: new URL(path, window.location.origin).toString(),
      title,
      width: 1280,
      height: 800,
      center: true,
    },
  })
}
