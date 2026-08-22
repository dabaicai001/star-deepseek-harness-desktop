# Agent Note: StarHub produced-files remainder opens a right-edge drawer

Status: implemented

English | [中文](2026-08-22-starhub-produced-files-drawer.zh.md)

## Problem

v0.91.0 made the produced-files row's `+ N 个文件` remainder expand the full changed-files list inline below the chip lane. Product feedback rejected that shape: a long list pushes the conversation apart and the inline panel reads as clutter inside the closing message. The ask: keep the row to the label and the fitting chips, and let the remainder button open a right-edge drawer listing every changed file grouped by 新增/修改. The same rework also had to retire the v0.92.0 leftovers the drawer replaces: the inline list's CSS classes, its locale keys, and the second-line Show in folder button.

## Decision

**The drawer is `ProducedFiles`-local UI.** `ProducedFilesDrawer` (`packages/client/ui-deliverables/src/client/ProducedFilesDrawer.tsx`) takes pure props — entries, the chips' viewer-first `open`, an optional `showInFolder`, `onClose`, and the `t` seat threaded from the row — and is shown by a `useState<boolean>` in `ProducedFiles`. No slot (slots are for cross-package composition; the drawer is one feature's local expansion), no store, no ctx, and no portal to `document.body` — a `position: fixed` layer at `z-index: 900` sits above the chat flow and below the global dialog (1000) and toast (1100) layers, which is all the locality the chat stream needs.

**Presentation.** A mask (`--dsw-alias-bg-mask-1`) closes on click; the panel hugs the viewport's right edge at `min(360px, calc(100vw - 48px))`, fills the viewport height, and slides in over 150ms (disabled under `prefers-reduced-motion`). The header carries 本轮改动文件(共 N 个) and a ×; the body groups rows under collapsible 新增 (created) and 修改 sections, 新增 first, each row showing the full path and the shared `Stats` +/- estimate; the footer shows 在文件夹中显示 only when the loopback Host reports `canOpenPath` (the same gating the removed second-line button had). Row clicks reuse the chips' opener (`viewFile` preferred, `openFile` fallback) and deliberately do not close the drawer — the in-shell viewer is a separate overlay, so the user keeps browsing the list. All styling runs on `--dsw-*` tokens; no literal colors.

**Accessibility.** `role="dialog"` + `aria-modal="true"` + `aria-labelledby`; focus lands on the × button on open, Escape closes from a document-level listener (the mask can hold focus), Tab cycles among the panel's buttons via the panel's own `onKeyDown`, and the owner's `closeDrawer` returns focus to the remainder button that opened it (`aria-haspopup="dialog"` mirrors the state).

**Shared `Stats` extraction.** The +/- badge moved into `ProducedStats.tsx` so the chips and drawer rows share one implementation without a circular import between `ProducedFiles` and its drawer.

## Alternatives considered

- **Keep the inline expansion and restyle it.** Rejected by product feedback directly; the whole point is removing an in-flow panel from the closing message.
- **Portal to `document.body` like `Modal`.** The Modal portal exists so ancestor stacking contexts cannot leave sticky controls above the mask. The drawer is a chat-local expansion, and `position: fixed` at the chosen z-index already clears the chat flow; a portal would also detach the layer from the component tree for no gained behavior.
- **A new slot for the drawer.** Slots are the cross-package composition API; nothing outside ui-deliverables renders or replaces this panel, so a slot would publish a composition point with no consumer.

## Consequences

The row's default form is back to label + ≤6 measured chips + remainder button; the v0.91.0 inline list (`expanded` state, `.list` / `.listHead` / `.collapse` / `.listRow` / `.tagCreated` / `.tagModified` / `.listPath` / `.showFolder` classes, `produced.collapse` / `produced.listTitle` locale keys) is fully removed. `tests/produced-files-drawer.client.spec.tsx` pins grouping order, row openers, all three close paths, section folding, the footer gating, and focus discipline; the row spec now asserts the drawer opens instead of the inline list. Both new source files sit at the per-file 100% coverage gate.

The same PR repaired the v0.92.0 memory series: the memory-context pre-step gate treated a never-written namespace as enabled (now explicit-true, matching the default-off setting), `memory-sink`'s abort check lost a `Promise.race` against an instantly-resolved generate (now checked before the call), `tsconfig.base.json` lacked explicit source-plane mappings for the three newest starhub packages (so vitest resolved `@deepseek-ai/dsh-starhub-memory-context` to its stale built lib), `memory-sink/tsconfig.json` missed the project reference, and both memory packages plus the settings files the series touched are now at the 100% coverage gate.
