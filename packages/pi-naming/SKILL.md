---
name: configure-pi-naming
description: 配置 Pi 统一 /rename、首条消息命名和终端目标归属。Use when configuring pi-naming.
---

# 配置 pi-naming / Configure pi-naming

读取 `<pi-agent-dir>/extensions/pi-naming/config.json`，遵守 `PI_CODING_AGENT_DIR`。使用 `/config:naming` 打开 TUI 配置菜单，输入 `reset` 恢复默认值，保存后 reload。字段和默认值见关联文档和配置示例。

Use `/config:naming` to open the normal TUI settings menu; use `reset` for defaults and reload after saving.

- `automaticNaming` / `manualNaming` 控制自动输入和 `/rename [名称]`，`targets` 分别控制 session/workspace/tab。Control automatic input and `/rename [name]`; `targets` selects session/workspace/tab.
- `title` 控制长度、语言、补充提示和超时；模型鉴权复用 Pi。Controls length, language, instructions and timeout; model authentication comes from Pi.
- 无终端也可命名 session；终端失败与跳过必须报告。Session naming works without a terminal; report terminal failures and skips.
- 子进程归属由启动方通过 mux 协议提供，不把 pane 扩大为共享 tab，不修改父 workspace。Launchers grant child targets through the mux protocol; never expand a pane to a shared tab or rename the parent workspace.
- 子代理需要显式配置 `subagentExtensions` 加载 naming。Child extension isolation requires explicitly loading naming in `subagentExtensions`.

运行 `npm run check -w pi-naming`。真实终端和模型未验证时标记 `NOT_RUN`，不以单元测试替代实测。

Run `npm run check -w pi-naming`. Mark unperformed real terminal/model checks `NOT_RUN`; unit tests are not a substitute.
