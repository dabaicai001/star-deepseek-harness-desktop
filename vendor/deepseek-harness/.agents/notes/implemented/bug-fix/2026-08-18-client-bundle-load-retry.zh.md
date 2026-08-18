# Agent Note: 客户端 bundle 加载器对瞬态抓取失败做有界退避重试

Status: implemented

[English](2026-08-18-client-bundle-load-retry.md) | 中文

## Problem

web 外壳通过经典 `<script src="/plugins/<id>/client.js?rev=<rev>">` 元素加载每个插件的客户端 bundle,元素的 `error` 事件会在首次尝试即以 `client-modules: bundle script <url> failed to load` 拒绝启动。该拒绝是永久性的,但它上报的失败在应用启动时往往是瞬态的:页面请求 bundle 时宿主服务进程正在更替(旧实例退出、新实例刚重绑同一端口)或 bundle 文件暂时不可读,而下一次尝试本可以成功。这样一次竞态在 StarHub 桌面安装版中表现为启动卡在 "Failed to load plugins" 并点名 `@deepseek-ai/dsh-session-log-export`;重启应用后面对完全相同的 bundle 即可干净启动。

## Decision

`packages/client/modules/src/client/system.ts` 的 `defaultLoadBundle` 按 `BUNDLE_RETRY_DELAYS`(300 ms、再 1200 ms)退避重试抓取,之后原样重抛原始错误。单次尝试的机制原样移入 `fetchBundle`:每次尝试新挂一个 script 元素,`load`/`error` 监听器带 `once`, settled 即移除节点,因此每次重试都是全新元素,已 settled 的节点不会在文档里堆积。`manifest.ts` 的 `loadBundle` seam 契约记录了默认实现的重试行为。一个始终不可服务的 bundle 仍会在三次尝试后带同样的报错响亮失败,只是比原来晚约 1.5 s。

## Alternatives considered

**在 `arrive()` 里包住整个到达流程重试。** 那会连带重跑「已加载但未注册」的失败分支,让到达了却未注册自身 id 的 bundle 重复执行,把重试面扩到瞬态传输失败之外。

**在外壳(`AppWebEntry`)或服务端(`serveBundle`)重试。** 外壳只能看到已包装好的拒绝,会把退避策略复制到拥有传输职责的模块系统之外;服务端重试对「根本没有服务在监听」这一最主要的启动竞态无能为力。

**启动失败时整页刷新。** 刷新会在可能仍在更替的服务器上重启整个启动流程,并丢弃 fiber 进度,把一个 bundle 的小抖动变成整轮重启循环的隐患。

## Consequences

瞬态启动抓取失败会在约 1.5 s 内自愈,启动继续推进,而不是把加载页钉死到用户重启应用为止。代价只在失败路径上支付:一个真正缺失的 bundle 现在三次尝试后才报错,响亮失败页面推迟了退避延迟之和。`packages/client/modules/tests/loader.client.spec.ts` 在假定时器下覆盖了重试后成功与重试耗尽两条路径,断言尝试次数与已 settled script 节点的移除。
