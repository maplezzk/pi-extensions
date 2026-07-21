# pi-hud

面向 [Pi coding agent](https://github.com/earendil-works/pi) 的会话耗时抬头显示：working spinner 实时计时，并在对话流中给出每轮耗时与全程总耗时。

[English](./README.md)

## 功能

- 工作期间 spinner 显示**从发出消息起的全程耗时**（如 `⏱ 47s`），跨轮次持续累加，不再每轮回零。
- 每个轮次结束时插入一条灰色文本，显示该轮精确耗时（`⏱ 本轮耗时 8.2s`）。
- AI 完全停止时（`agent_settled`，覆盖自动重试、compaction 续跑以及 Esc 中断）追加一行**从发出消息到停止的总耗时**（`⏱ 总耗时 18.9s`）。

## 安装

```bash
pi install npm:pi-hud
```

## 实现说明

- 总耗时以 `input` 事件（用户提交消息的时刻）为起点、`agent_settled` 为终点，因此多轮工具调用、自动重试和队列续跑都计入同一次总耗时；运行中发送的 steer/followUp 消息不会重置起点。
- 非 TUI 模式（rpc/print）下不启动定时器、不发送通知。

## 国际化

所有面向用户的文案均通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US` 双语。
