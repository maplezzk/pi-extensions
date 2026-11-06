# pi-metrics

面向 [Pi coding agent](https://github.com/earendil-works/pi) 的会话指标扩展：实时耗时计时 + token 生成遥测，支持两种显示时机。

[English](./README.md)

## 功能

- 工作期间 spinner 显示**从发出消息起的全程耗时**（如 `⏱ 47s`），跨轮次持续累加，不再每轮回零。
- **显示时机**决定指标行什么时候出现：
  - `on-stop`（默认）：运行过程中对话区保持干净；AI 完全停止（`agent_settled`，覆盖自动重试、compaction 续跑以及 Esc 中断）后只出一行汇总：总耗时、混合 TPS、TTFT、in/out 合计、stall 和综合费率。
  - `live`：每轮结束时立刻出一行（该行已包含本轮耗时，不再单独发耗时提示）；整段超过一轮时再补一行 `⏱ <耗时>`。
- 两种模式都会把每轮遥测写进 `tps` custom session entry，恢复 session 或 `/tree` 后照常恢复显示。
- Metrics 通过 session entry 和通知提供。使用 `/config:metrics` 打开 TUI 配置面板，或用 `/config:metrics enable|disable|live|on-stop|reset` 直接改一项。

## 配置

配置文件为 `<Pi agent 目录>/extensions/pi-metrics/config.json`：

```json
{
  "enabled": true,
  "display": "on-stop"
}
```

| 字段 | 取值 | 默认 | 含义 |
| --- | --- | --- | --- |
| `enabled` | `true` / `false` | `true` | 总开关；`false` 时完全不注册指标处理器。 |
| `display` | `"on-stop"` / `"live"` | `"on-stop"` | 指标行何时出现：整段停下后汇总一行，还是每轮一行。 |

用 `/config:metrics` 打开配置面板（总开关回车切换，显示时机回车选；每改一项立即写盘并生效，不需要 `/reload`），或用带参数的形式改单个字段；手动修改文件后执行 `/reload`。可参考 [`config.example.json`](./config.example.json)。

## 汇总行是怎么算的

```
⏱ 2m 14.3s · TPS 62.4 tok/s · TTFT 1.2s · in 48.2K · out 12.7K · $0.42/M
```

- 开头的 **`⏱`** 数值从你发出消息算到 `agent_settled`，与 spinner 一直在显示的是同一个时钟，数字对得上。
- **TPS** 按输出 token 加权（总输出量 ÷ 生成时间之和），单轮输出很少也不会把整段均值带偏。
- **TTFT** 取本段第一个可测值，也就是「多久看到第一个字」。
- **in/out** 是各轮求和；**stall** 只在检测到停顿且时长大于 0 时出现。
- **费率**用真正计费的金额（provider 报账单时用实际账单，否则用列表价）折算每百万 token。

## 安装

```bash
pi install npm:pi-metrics
```

## 实现说明

- 总耗时以 `input` 事件（用户提交消息的时刻）为起点、`agent_settled` 为终点，因此多轮工具调用、自动重试和队列续跑都计入同一次总耗时；运行中发送的 steer/followUp 消息不会重置起点。
- `on-stop` 模式把每轮结束的指标累加进一个运行累加器（只保留聚合量，不囤各轮原始记录），在 `agent_settled` 时合成一行；账单迟到时重算并重发这一行，而不是补一条单轮行。
- 非 TUI 模式（rpc/print）下不启动定时器、不发送通知。
- Neuralwatt 成本监听器会在 `session_shutdown` 时取消订阅，恢复通知的延迟定时器也会在 reload/session 切换时清理。

## 从 pi-tps 迁移

TPS 实现现在由本包维护。启用本包前，请从 Pi 配置中移除独立的 `npm:@monotykamary/pi-tps`，否则两个扩展会重复写入 `tps` 条目并重复通知。

## 国际化

所有面向用户的文案均通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US` 双语。
