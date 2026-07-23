# pi-metrics

面向 [Pi coding agent](https://github.com/earendil-works/pi) 的会话指标扩展：working spinner 实时计时，并提供每轮 TPS、TTFT 和 token 使用量。

[English](./README.md)

## 功能

- 工作期间 spinner 显示**从发出消息起的全程耗时**（如 `⏱ 47s`），跨轮次持续累加，不再每轮回零。
- 每个轮次结束时插入一条灰色文本，显示该轮精确耗时（`⏱ 本轮耗时 8.2s`）。
- AI 完全停止时（`agent_settled`，覆盖自动重试、compaction 续跑以及 Esc 中断）追加一行**从发出消息到停止的总耗时**（`⏱ 总耗时 18.9s`）。
- 每轮 LLM 调用结束后显示 TPS、TTFT、token 数、生成耗时、stall 和可用的综合成本。
- Telemetry 以 `tps` custom session entry 持久化，并在恢复 session 或 `/tree` 后恢复显示。
- `/tps-export` 导出 TPS JSONL，`/session-export` 导出 session JSONL。

## 从 pi-tps 迁移

TPS 实现现在由本包维护。启用本包前，请从 Pi 配置中移除独立的 `npm:@monotykamary/pi-tps`，否则两个扩展会重复写入 `tps` 条目并重复通知。

## 安装

```bash
pi install npm:pi-metrics
```

## 实现说明

- 总耗时以 `input` 事件（用户提交消息的时刻）为起点、`agent_settled` 为终点，因此多轮工具调用、自动重试和队列续跑都计入同一次总耗时；运行中发送的 steer/followUp 消息不会重置起点。
- 非 TUI 模式（rpc/print）下不启动定时器、不发送通知。
- Neuralwatt 成本监听器会在 `session_shutdown` 时取消订阅，恢复通知的延迟定时器也会在 reload/session 切换时清理。

## 国际化

所有面向用户的文案均通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US` 双语。
