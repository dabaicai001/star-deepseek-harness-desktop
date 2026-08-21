# Agent Note: StarHub long-term memory injects into the agent context with folder scopes and a master switch

Status: implemented

English | [中文](2026-08-21-starhub-memory-context-injection.zh.md)

## Problem

StarHub's memory feature was write-only: the model's `memory` tool persisted cards into the `ai_memories` SQLite table through `ai_memory_add`/`ai_memory_replace`/`ai_memory_remove`, and the Settings dialog listed and edited them through `ai_memory_list`/`ai_memory_update`/`ai_memory_delete`. The read path (`ai_memory_cards`, commented as "system prompt injection") had zero callers across the repository: no front-end code invoked it and no Rust code consumed it. After the Vue shell was replaced by the dsh web GUI, the old `useAiDshHost`-style card assembly that gated injection behind the `memoryEnabled` localStorage flag disappeared with it, so the model never saw its own memories in a new session — the `memory` tool's description promise ("memory appears in your context at the start of later sessions") was unfulfilled. Memory also had no workspace-folder dimension: scopes were only `user`/`global`/`asset:{id}`, so per-folder knowledge could not be attached to the folder it belongs to.

## Decision

A new host plugin `@deepseek-ai/dsh-starhub-memory-context` (packages/starhub/memory-context, mounted in both the web profile `examples/starhub-web/cordis.patch.yml` and the embedded AI profile `examples/starhub-agent/cordis.yml`) listens on the `agent/pre-step` waterfall. For each step it composes memory cards from the scopes `['user', 'global', ...(cwd ? ['folder:' + cwd] : [])]` — the cwd comes from `agent.session.header.cwd` — and injects them as a plugin-source user message before the model request. The cards are pulled over the SDK transport with a new bidirectional RPC method `starhub/memory.cards` (Rust side `src-tauri/src/harness/mod.rs`, `handle_memory_cards`), which validates non-empty scopes, resolves the session's bound asset via `bridge.resolve_asset` to append `asset:{id}`, and returns `build_memory_cards` output. A 2-second timeout plus transport-absent and malformed-result paths degrade to no injection; empty card sets render nothing.

The master switch is real: the plugin's settings namespace `starhub-memory-context` (`enabled: boolean`, default true) gates injection, and the Settings → AI 助手「启用长期记忆」toggle writes that namespace through the settings channel (`syncMemoryEnabled` in client-nav). When off, the pre-step listener short-circuits before any transport call; the toggle also boot-syncs once from localStorage so a previously disabled user stays disabled. The other three AI-settings toggles remain localStorage-only UI state (documented in the plugin README Known Limitations).

Folder scope is a first-class memory target: the `memory` tool's `target` enum gains `'folder'`, and execution resolves the session cwd (`exec.agent?.session.header.cwd`) into `folder:<absolute path>` (empty cwd yields a guidance text instead of an error). Rust `memory_scope_limit` adds the `folder:` branch with a 2200-character cap (`MEMORY_LIMIT_FOLDER`), and the Settings memory dialog labels folder cards as `工作区 — <basename>(<path>)`.

## Alternatives considered

**Reuse the existing `starhub/tool.execute` bridge with a read-only action instead of a new RPC method.** The tool bridge routes by tool name and runs the full tool pipeline; a memory-card pull is not a tool call and would need a synthetic tool plus access to the current session's cwd/asset that the pre-step already has. A dedicated method keeps the read path explicit and lets `handle_memory_cards` fail fast on missing scopes.

**Scope key `workspace:<id>` instead of `folder:<path>`.** Workspace ids are UI registry ids that change when a workspace is deleted and recreated, while memory is anchored to the folder's content. The canonical path is already fixed at workspace creation (`fs.realpath`) and mirrors the existing `asset:{id}` shape, so `folder:<path>` requires zero schema or migration work on the free-form `scope` column.

**Gate the toggle purely on the host side (settings.yaml) and drop localStorage.** The pre-step plugin already reads the settings namespace, but the toggle's UI state lives in `ai-v2` localStorage from the pre-kernel era. The bridge writes the namespace from the toggle on change and once at startup, keeping both sources consistent without migrating the settings UI wholesale.

## Consequences

New sessions now carry their own persistent memory: user profile, environment notes, the current workspace folder's notes, and the bound asset's notes each render as titled sections in a plugin-source message, capped per scope (user/asset 1375 chars, global/folder 2200). The memory tool's promise is fulfilled, and folder-scoped writes land where they can actually be retrieved. The cost is one more host plugin and one more bidirectional RPC in the local bridge (with soft-failure semantics so a stalled or absent transport never blocks a step), plus a settings round-trip at startup to mirror the localStorage toggle. Web and embedded AI profiles stay in sync because both mount the plugin, and `web.rs` `LOCAL_PACKAGES` plus `package-dsh-runtime.ts` carry the package into the packaged runtime.
