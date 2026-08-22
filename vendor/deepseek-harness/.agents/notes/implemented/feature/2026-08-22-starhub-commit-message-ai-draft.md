# Agent Note: StarHub git branch pill drafts commit messages through a one-shot LLM HTTP endpoint

Status: implemented

English | [中文](2026-08-22-starhub-commit-message-ai-draft.zh.md)

## Problem

The session-header git branch pill ([branch pill note](2026-08-21-starhub-session-header-git-branch-pill.md)) could stage and commit, but the user still had to write the commit message by hand. Drafting it with AI needs a one-shot model call from the web GUI, and the client had no channel for one: `IApiClient` exposes no auxiliary-LLM RPC, credentials live host-side only, and routing the draft through the chat session would pollute the conversation and fire the full agent loop for a formatting task.

## Decision

A new StarHub-local host package, `packages/starhub/commit-message`, claims the exact route `POST /starhub/git/commit-message` on `ctx.webServer`. The client (`git-service.ts` `gitDraftCommitMessage`) gathers `git status --porcelain`, `git diff HEAD --stat` (falling back to `git diff --stat` before the first commit), and the last 8 commit subjects through the existing Tauri `local_shell_exec`, clips them to a byte budget, and POSTs the summary as JSON. The plugin resolves the model route from `agentDefaultModel.currentSelection()` (a `provider`/`model` pair in cordis.yml overrides it, paired or failed), frames the summary as one JSON-carrying user message, and runs one `ctx.llm.stream` call with `maxOutputTokens`/`timeoutMs` budgets from its required Loader config; the system prompt pins a ≤72-character subject, convention/language matching against the recent subjects, and a no-invention rule. The draft lands back in the pill's input for the user to review, edit, and commit. Wire failures map to 400 (body), 405 (method), 413 (over budget), and 502 (generation).

The endpoint deliberately does no git work itself: the client owns the workspace and the Tauri capability, the host owns the model and credentials. Input arrives pre-summarized, so the model never receives a raw multi-megabyte diff.

## Alternatives considered

**Send the draft request through the current chat session.** `session.prompt` exists on `IApiClient`, but it appends a visible turn, runs the full tool loop, and entangles a UI micro-call with session state and approvals; the reply would still need scraping out of the conversation projection.

**A Typert Remote service with generated descriptors.** That is the sanctioned typed RPC path, but it requires descriptor generation, an api-remotes allowlist entry, and client `remote.$mount` wiring — heavy machinery for one JSON-in/JSON-out call. A plain exact route on `webServer` is the same pattern `starhub-host-static` already uses and needs no client framework support beyond `fetch`.

**Give the pill its own provider settings.** Duplicating credential storage client-side breaks the single source of truth (GUI 设置 → 模型) and leaks keys into the webview; resolving through `agentDefaultModel` keeps the deployment default authoritative.

## Consequences

`LOCAL_PACKAGES` (src-tauri `harness/web.rs`), `WEB_LOCAL_PACKAGE_DIRS` (package-dsh-runtime.ts), the starhub-web profile manifest and patch layer, the examples manifest, and the host tsconfig aggregate all name the new package; a missing copy fails loud at profile boot. The call is session-less: it is not logged to any session log and costs no conversation context. The summary-only input means brand-new files are described by name alone, so drafts for them stay generic until a future `diffPreview` field. The same change hardened the Windows console flash: `local_shell_exec` and the two harness `cmd` spawns now pass `CREATE_NO_WINDOW`, because the pill's per-session-switch `git` probe was spawning a visible console window from the GUI process.
