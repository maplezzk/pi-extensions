# pi-notifications

面向 [Pi coding agent](https://pi.dev) 的可配置外部通知扩展。

[English](./README.md)

## 功能

- 在 `ask_user_question` 或旧版 `ask_user` 工具等待输入前发送系统通知。
- 每次 Pi agent 运行结束后发送完成通知，包含工具是否报错和已完成的 turn 数。
- 使用 Node 的 argv API 执行 adapter，不经过 shell，通知文本不会被重新解析为命令语法。
- 运行时探测配置的命令。命令缺失或首次执行失败时，在当前会话明确提示一次，随后停用本次运行的外部通知。
- 通知失败不会阻塞 Pi 的 agent 生命周期或工具执行。
- 所有运行时文案均通过 `pi-extensions-i18n` 国际化。

## 安装

```bash
pi install npm:pi-notifications
```

然后重新加载 Pi：

```text
/reload
```

本包会自动安装共享的 i18n 依赖。默认 adapter 要求 `terminal-notifier` 位于 `PATH` 中。

## 配置

可选配置文件路径：

```text
<Pi agent 目录>/extensions/pi-notifications/config.json
```

`<Pi agent 目录>` 是 Pi 当前配置的 agent 目录（通常为 `~/.pi/agent`）。可以从 [`config.example.json`](./config.example.json) 开始。配置字段如下：

- `enabled`：设为 `false` 可关闭外部通知。
- `adapter.command`：可执行文件名或路径。
- `adapter.args`：argv 参数数组；每个参数中的 `{title}`、`{subtitle}`、`{message}` 会被替换。
- `timeoutMs`：单次 adapter 执行的最长时间。

例如，直接使用另一个通知命令：

```json
{
  "enabled": true,
  "adapter": {
    "command": "notify-send",
    "args": ["{title}", "{message}"]
  },
  "timeoutMs": 3000
}
```

配置在扩展加载时读取。修改后请重新加载 Pi。配置文件不存在时使用默认的 `terminal-notifier` 配置；配置格式损坏时会在 Pi 中明确提示并使用默认配置。

## 默认 adapter

默认 argv 等价于：

```text
terminal-notifier -title <title> -subtitle <subtitle> -message <message> -sound default -timeout 5
```

请使用适合当前操作系统的包管理器安装它，或配置其他通知可执行文件。本包不假定某个特定操作系统 daemon 存在。

## 国际化

运行时文案通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US`。使用 `/config:language` 或 `PI_EXTENSIONS_LOCALE` 设置共享语言。

## 许可证

MIT
