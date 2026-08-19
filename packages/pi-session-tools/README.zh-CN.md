# pi-session-tools

Pi 会话辅助扩展包，默认加载 bash 管道输出缓存和对话压缩。

[English](./README.md)

## 安装

```bash
pi install npm:pi-session-tools
```

随后执行 `/reload`。

## 功能

- 当 bash 管道中使用 `grep`、`tail` 或 `head` 过滤输出时，将过滤前的完整输出写入系统临时目录下的 `pi-pipe-cache/`，并在结果中给出路径，可以直接对缓存文件重新过滤而不用重跑命令。
- 提供 `session_log`：按原索引列出尚未压缩的用户消息和可选起点。已经作为压缩起点的消息不再返回，但仍可通过 `/tree` 找回。
- 提供 `session_squash`：接收总结，并把从指定消息开始的对话压缩为该总结。原对话不删，可通过 Pi 的 `/tree` 找回。
- 总结由主 agent 基于完整对话上下文生成，并直接随 `session_squash` 调用提交（不发独立 LLM 请求，也没有 finalize 步骤）；被压缩范围内读/改过的文件清单会自动附上。

调用 `session_squash` 前先调用 `session_log`，用已完成回合的编号作为 `from`，并把完整结构化总结传给 `session_squash`。后续压缩可以从更早的索引重新开始并覆盖更大范围，不再限制必须晚于上一次压缩点。压缩完成后自动继续干活。只在任务边界压缩（一个任务完整交付、准备开新任务时），绝不在任务执行中途压缩。

## 上下文阈值提示

对话变长跨过阈值时（默认 150k / 200k / 250k / 300k tokens），会提醒主 agent 在任务边界时考虑压缩，不强制。仅在模型正常停止时触发；用户手动终止或提供方异常不会触发。可配置：

```jsonc
// ~/.pi/agent/extensions/pi-session-tools/config.json
{ "squashContextThresholds": ["150k", "200k", "75%"] }   // k、数字与百分比可混合
```

也可用交互式命令 `/config:session-tools`（别名 `/pi-session-tools`）配置。

也支持环境变量 `PI_SESSION_TOOLS_SQUASH_THRESHOLDS`（逗号分隔，如 `150k,75%`）。

## 本地化

全部用户可见文案通过 `pi-extensions-i18n` 提供中英双语（zh-CN / en-US）。
