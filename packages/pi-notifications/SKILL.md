---
name: configure-pi-notifications
description: 配置与排查 pi-notifications 的外部通知命令、argv 参数、超时和一次性失败提示。Use when configuring or diagnosing Pi external notifications.
---

# 配置 pi-notifications

## 配置文件

读取实际 Pi agent 目录下的 `extensions/pi-notifications/config.json`。不存在时使用内置默认配置；不要猜测未列出的字段。可以从包内 `config.example.json` 开始。

配置字段：

- `enabled`：布尔值，默认 `true`。
- `adapter.command`：通知可执行文件名或路径，默认 `terminal-notifier`。
- `adapter.args`：argv 字符串数组；支持 `{title}`、`{subtitle}`、`{message}` 占位符。
- `timeoutMs`：正整数，默认 `3000`。

修改配置后执行 `/reload`。配置文件损坏会明确提示，并使用默认配置继续启动。

## 运行行为

- `ask_user_question` 和 `ask_user` 在真正等待输入前发送通知。
- `agent_end` 发送完成通知，并根据 tool result 是否报错选择完成或错误标题；消息包含 turn 数和耗时。
- 命令通过 argv 执行，不经过 shell；不要把整条 shell 命令写入 `adapter.args`。
- 扩展加载时不依赖外部命令存在；第一次发送通知时探测命令。
- 命令缺失或第一次执行失败只提示一次，并停用当前运行的外部通知；Pi 任务继续执行，不要重试或阻塞。
- 运行时文案语言由 `pi-extensions-i18n` 控制。

## 排查

1. 检查配置文件的 JSON、`enabled`、命令和 argv 参数类型。
2. 在当前 Pi 进程的 `PATH` 中确认配置的命令可执行。
3. 如果看到一次“命令不可用”或“执行失败”提示，先修复命令或配置，再执行 `/reload`。
4. 不要读取凭据、Pi settings 或私有服务来排查通知 adapter。

## 验证

- 定向测试：`npm test --workspace pi-notifications`。
- 类型检查：`npm run typecheck --workspace pi-notifications`。
- 手动 TUI 验证：在 agent 触发一次 `ask_user_question`，再完成一次普通任务；确认系统通知出现且 Pi 不被阻塞。
- 缺少通知命令、命令退出失败和超时属于预期降级场景；确认每种场景只出现一次明确提示。
