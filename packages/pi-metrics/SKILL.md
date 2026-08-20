---
name: configure-pi-metrics
description: "启用与排查 pi-metrics 的耗时、TPS、TTFT、token 和成本遥测。Use when configuring or diagnosing Pi session metrics."
---

# 配置 pi-metrics

`pi-metrics` 当前没有配置文件或配置命令；不要编造开关、阈值或导出命令。配置动作仅限安装、启用或禁用该 package，以及共享语言设置。

## 诊断与修改

1. 确认 `npm:pi-metrics` 已安装且扩展资源已启用。
2. 若同时启用了 `npm:@monotykamary/pi-tps`，先让用户选择保留一个；两者会重复写入 `tps` session entry 和通知。
3. 文案语言由 `pi-extensions-i18n` 控制。

## 验证

在 TUI 中完成一次真实模型回合，观察 working spinner、轮次耗时、总耗时和可用的 TPS/TTFT/token/cost。RPC/print 模式不会启动 UI 定时器或通知；provider 未返回 usage 时部分指标不可用。真实模型回合属于 E2E，执行前遵守当前任务授权边界；未运行时明确报告 `NOT_RUN`。
