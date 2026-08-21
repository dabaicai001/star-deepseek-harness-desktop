# Agent Note: StarHub tool-card file links open an in-shell viewer with before/after edit columns

Status: implemented

English | [中文](2026-08-21-starhub-file-viewer-overlay.zh.md)

## Problem

Read and Edit tool cards in the dsh conversation render a file link (`ToolRow.tsx` `fileLink`) whose click previously fell through to the OS default application via `workspaces.openPath`. That is disruptive inside an AI-driven workflow: the user leaves the app to view the file, and there is no way to see the exact change the Edit tool is about to apply (or applied), let alone adjust it. The repository also had no side-by-side diff surface for the `DiffHunk { path, oldText, newText }` data the diff card model already exposes.

## Decision

`packages/starhub/client-nav` registers `FileViewerOverlay` on `shell.overlay` (id `starhub-file-viewer`, order 110) and provides a cross-plugin service `starhubFileViewer` (a `createSnapshotStore` bridge) whose `open` callback accepts a `FileViewRequest`. The `viewFile` owner prop threads the entry point: ui-tool's `ToolCallOwnerProps.viewFile?` (optional) flows through `ToolCallTree` into `ToolRow`, where the file link prefers `onViewFile` over the OS-open `onOpenFile`; the fallback stays intact for compositions without the service. The request is built in the tool views: read rows send `{ kind: 'read', path }`, and file-mutation rows build `{ kind: 'edit', path, diffs }` from `diffCardModel(block)?.card.diffs` with `oldText: null` normalized to `''`.

The overlay reads content through Tauri `local_read_text_file` (256 KB window, truncated flag surfaced as a notice) and writes through `local_write_text_file`. Read mode shows the current file content; Edit mode renders two editable columns — 变更前 (before) and 变更后 (after) — joined by the `HUNK_SEPARATOR` marker. Editing and saving are gated on the session being idle: `useSessions(s => s.byId[target.sessionId]?.running ?? false)` disables the editors and the save button and shows the 「AI 运行中只能查看」 banner while a run is active. Saving a read view writes the edited content directly; saving an edit view splits the after column on the separator, re-reads the latest file, applies each hunk's `oldText → newText` at its first occurrence (`applyDiffs`), and writes the result — hunks with empty `oldText` (pure insertion) or missing anchors are rejected with a message.

## Alternatives considered

**Open the file in a new OS window via `window.open` or `openNewPage`.** dsh web is a route-less SPA with no new-window precedent, and StarHub's `openNewPage` targets asset workbenches keyed by asset id, not files. An in-app overlay keeps the user inside the AI workflow and can host the before/after comparison natively.

**Add a `host.readFile` RPC to the apiproxy for the content channel.** That touches `api/rpc-map.ts`, the IApiClient contract, the trust fence's `PRIVILEGED_METHODS`, and the handler/impl layers. The desktop product already grants `local_read_text_file`/`local_write_text_file` to the 127.0.0.1 dsh shell origin, so the overlay reuses the Tauri IPC surface with zero ACL or apiproxy work — and gains a write path the RPC alternative lacked.

**Reuse `ReadBlock` for the viewer body.** `ReadBlock` carries shiki highlighting and its own model dependencies; the viewer only needs raw content with truncation awareness, so a lightweight `<pre>` view keeps the overlay independent.

## Consequences

Clicking a Read or Edit file link now opens the file inside the app: Read shows current content, Edit shows 变更前/变更后 columns, and both are editable exactly when the session is idle — during an AI run the overlay is read-only with an explicit 「AI 运行中只能查看」 notice, fulfilling the requirement that running edits are forbidden. Edit saves re-apply hunks against the latest file rather than trusting the stale snapshot, which makes concurrent file changes visible as apply failures instead of silent clobbers. The cost is a second shell.overlay tenant alongside `StarHubOverlay`, three new Tauri IPC consumers in the web GUI, and a deliberately optional `viewFile` contract so plain dsh web and existing tests are unaffected.
