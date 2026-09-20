---
name: configure-pi-metrics
description: "启用与排查 pi-metrics 的耗时、TPS、TTFT、token 和成本遥测。Use when configuring or diagnosing Pi session metrics."
---

# 配置 pi-metrics

配置文件为 `<Pi agent 目录>/extensions/pi-metrics/config.json`，字段有 `enabled`（默认 `true`）和 `display`（`"on-stop"` 默认 / `"live"`）。可以使用 `/config:metrics` 打开 TUI 菜单（每次选择都会保存并重新打开，选「完成」退出），或用 `/config:metrics enable|disable|live|on-stop|reset` 直接改一项。手动修改配置文件后执行 `/reload`。

`display` 决定指标行何时出现：`on-stop` 只在整段运行停下后出一行汇总（总耗时 · 混合 TPS · TTFT · in/out · stall · 费率），`live` 每轮结束就出一行。spinner 上的实时耗时两种模式都有。

## 诊断与修改

1. 确认 `npm:pi-metrics` 已安装且扩展资源已启用。
2. 若同时启用了 `npm:@monotykamary/pi-tps`，先让用户选择保留一个；两者会重复写入 `tps` session entry 和通知。
3. 只有在 `live` 模式才应该看到每轮指标行；`on-stop` 模式下每轮都没有提示属于预期行为，不要当成 bug。
4. 文案语言由 `pi-extensions-i18n` 控制。

## 验证

在 TUI 中完成一次真实模型回合：两种模式都应看到 working spinner 计时；`on-stop` 模式在停下后只出现一行汇总，`live` 模式每轮一行、多轮时另有一条 `⏱ <耗时>`（只有图标和数值，不带「总耗时」字样）。RPC/print 模式不会启动 UI 定时器或通知；provider 未返回 usage 时部分指标不可用。真实模型回合属于 E2E，执行前遵守当前任务授权边界；未运行时明确报告 `NOT_RUN`。
