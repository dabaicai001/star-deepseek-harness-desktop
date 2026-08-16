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
