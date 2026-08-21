# Agent Note: StarHub session header hosts a git branch pill with search, checkout, commit, and push

Status: implemented

English | [中文](2026-08-21-starhub-session-header-git-branch-pill.zh.md)

## Problem

The dsh conversation session header exposes two list slots — `conversation.session.header.actions` (beside the title) and `conversation.session.header.utilities` (right-aligned) — and StarHub's desktop product targets git workspaces, yet the header showed nothing about the current repository state. Users had to leave the AI conversation to check or change the branch, stage and commit changes, or push. There was also no precedent for a browser-rendered component executing git: `IApiClient` has no command-execution surface, and the model-facing `starhub/tool.execute` bridge is not a UI channel.

## Decision

`packages/starhub/client-nav` registers `GitBranchPill` on `conversation.session.header.actions` with id `starhub-git-branch` and `order: 30`, landing it between the subagent catalog (10) and job list (20) on one side and the right-aligned Session log button on the other. The component takes `PropsRuntime<'conversation.session.header.actions'>` and derives the working directory from `useSessions(list => list.byId[sessionId]?.cwd)`. It renders nothing when the cwd is absent (blank session before the host frame arrives), when the directory is not a git work tree (probed with `git rev-parse --is-inside-work-tree`), or when Tauri IPC is unavailable (browser preview), degrading like the other StarHub Tauri-backed widgets.

Git execution goes through the already-granted Tauri `local_shell_exec` command (`git-service.ts` wraps `tauriInvoke`): `git branch --show-current` for the pill label (detached HEAD renders as `(detached <sha>)`), `git branch --format=%(refname:short)` for the searchable list, `git checkout <branch>` to switch, `git add -A` + `git commit -m <message>` to commit, and `git push` with a 120-second timeout. A dirty-work-tree dot comes from `git status --porcelain`. PowerShell single-quote escaping (`psQuote`) protects branch names and commit messages, and the first output line or the stderr is shown inline in the panel.

## Alternatives considered

**Register on `conversation.session.header.utilities` instead.** The utilities cluster is right-aligned next to Session log; branch identity is session context, so the actions cluster matches the existing job-list/subagent placement and keeps the branch visible next to the session title.

**Add a dsh host git endpoint (prefix route or apiproxy RPC) for browser-portable execution.** That touches the upstream `api/rpc-map.ts` plus the IApiClient contract, and the desktop product already ships a privileged Tauri shell with `local_shell_exec` ACL'd for the 127.0.0.1 dsh shell origin. Reusing it costs zero Rust or ACL work; the browser-preview loss is accepted because StarHub's git workflows are desktop-only.

**Wrap checkout/commit/push in `RiskConfirmation` before executing.** The dsh `RiskConfirmation` precedent guards high-risk toggles (full-access permissions). Branch switching, committing, and pushing are routine user-initiated operations on the user's own workspace with visible inline results; a confirmation modal would interrupt the compact panel for little safety gain.

## Consequences

A session pinned to a git workspace shows its branch at a glance, with dirty-state indication, and offers search-and-checkout, commit-all, and push without leaving the conversation. Non-git sessions and browser previews render nothing. The cost is a second consumer of `local_shell_exec` from the web GUI (the first was the file viewer), a PowerShell quoting helper that must stay correct for arbitrary branch and message input, and a 120-second cap on push for large repositories.
