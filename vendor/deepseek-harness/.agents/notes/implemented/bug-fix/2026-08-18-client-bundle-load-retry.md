# Agent Note: Client bundle loader retries transient fetch failures with bounded backoff

Status: implemented

English | [中文](2026-08-18-client-bundle-load-retry.zh.md)

## Problem

The web shell loads every plugin's client bundle through a classic `<script src="/plugins/<id>/client.js?rev=<rev>">` element, and the element's `error` event rejected the boot with `client-modules: bundle script <url> failed to load` on the first attempt. That rejection is permanent, yet the failures it reports are frequently transient at application startup: the webview requests a bundle while the host server process is mid-swap (an old instance dying while its replacement rebinds the same port) or the bundle file is momentarily unreadable, and the very next attempt would succeed. One such race surfaced in the installed StarHub desktop app as a boot stuck on "Failed to load plugins" naming `@deepseek-ai/dsh-session-log-export`; restarting the app booted cleanly against an identical bundle.

## Decision

`defaultLoadBundle` in `packages/client/modules/src/client/system.ts` retries the fetch over the delays in `BUNDLE_RETRY_DELAYS` (300 ms, then 1200 ms) before rethrowing the original error unchanged. The single-attempt mechanics moved into `fetchBundle` without modification: one appended script element per attempt, `load`/`error` listeners with `once`, and node removal on settlement, so each retry is a fresh element and settled nodes never accumulate in the document. The `loadBundle` seam contract in `manifest.ts` documents the retrying default. A bundle that never becomes servable still fails loud with the same message after three attempts, roughly 1.5 s later than before.

## Alternatives considered

**Retry in `arrive()` around the whole arrival.** That would also re-run the "loaded without registering" failure branch, re-executing bundles that arrived but never registered their id and widening the retried surface beyond the transient transport failure.

**Retry in the shell (`AppWebEntry`) or the server (`serveBundle`).** The shell only sees the already-wrapped rejection and would duplicate the backoff policy outside the module system that owns the transport; a server-side retry cannot help when the failure is that no server is listening at all, which is the dominant startup race.

**Reload the page on boot failure.** A reload restarts the entire boot against a possibly still-swapping server and discards fiber progress, turning a one-bundle hiccup into a full re-boot loop risk.

## Consequences

A transient startup fetch failure self-heals within ~1.5 s and the boot proceeds instead of pinning the loading page until the user restarts the application. The cost is paid only on the failure path: a genuinely missing bundle now reports after three attempts instead of one, delaying the loud failure page by the sum of the backoff delays. Tests in `packages/client/modules/tests/loader.client.spec.ts` cover the retry-then-succeed path and the exhausted-retry path under fake timers, asserting the attempt count and that settled script nodes are removed.
