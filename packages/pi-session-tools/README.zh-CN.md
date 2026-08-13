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
- 提供 `session_log`：列出对话里你的每条消息和可压缩起点。
- 提供 `session_squash`：把从指定消息开始的对话压缩成一份摘要。原对话不删，可通过 Pi 的 `/tree` 找回。
- 摘要由主 agent 基于完整对话上下文直接生成（不发独立 LLM 请求），写成文档落盘到系统临时目录，同时作为摘要进入压缩后的对话；主 agent 没交出摘要时自动取消，可重试。

调用 `session_squash` 前先调用 `session_log`，用已完成回合的编号作为 `from`。压缩完成后自动继续干活。

## 上下文阈值提示

对话变长跨过阈值时（默认 150k / 200k / 250k / 300k tokens），会提醒主 agent 考虑压缩，不强制。可配置：

```jsonc
// ~/.pi/agent/extensions/pi-session-tools/config.json
{ "squashContextThresholds": [150000, 200000, "75%"] }   // 数字与百分比可混合
```

也支持环境变量 `PI_SESSION_TOOLS_SQUASH_THRESHOLDS`（逗号分隔，如 `150000,75%`）。

## 本地化

全部用户可见文案通过 `pi-extensions-i18n` 提供中英双语（zh-CN / en-US）。
