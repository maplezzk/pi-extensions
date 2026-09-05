---
name: configure-pi-naming
description: "配置与排查会话自动命名、手动 workspace/tab 改名及终端能力。Use when configuring automatic session titles or manual terminal naming."
---

# 配置 pi-naming / Configure pi-naming

读取 Pi agent 目录下的 `extensions/pi-naming/config.json`，遵守 `PI_CODING_AGENT_DIR`。三个布尔开关默认开启，修改后 `/reload`：

- `automaticNaming`：新 session 首条真实输入后生成短标题，只改 Pi session。
- `workspaceRename`：注册 `/rename:workspace [名称]`；无参数时生成标题，终端改名成功后才同步 Pi session。
- `tabRename`：注册 `/rename:tab <名称>`，只改终端。

Read `extensions/pi-naming/config.json` under the Pi agent directory. All three boolean switches default to true; reload after changes. Automatic naming changes only the Pi session. Workspace naming synchronizes the session only after a successful manual terminal rename. Tab naming changes only the terminal.

## 边界 / Boundaries

标题优先 10 字符、最多 15 个 Unicode 码点；请求 10 秒超时。自动命名不覆盖手动名称，不依赖终端后端。关闭两个终端开关时不加载终端模块。标题生成是包内实现，不从 session-tools 导入。

Titles prefer 10 characters and are capped at 15 Unicode code points. Requests time out after 10 seconds. Automatic naming preserves manual names and works without a terminal backend. Disabling both terminal switches avoids loading the terminal module. Title generation is internal, not imported from session-tools.

## 排查 / Troubleshooting

- 配置损坏会报告并跳过所有命名注册；修复并 reload。Invalid configuration is reported and skips all naming registration; fix it and reload.
- 终端的 unsupported/disabled/failed 不是成功，不应同步 session。Terminal unsupported/disabled/failed results must not synchronize the session.
- tmux window/session 和 Herdr workspace 开关沿用 terminal-mux。Backend opt-ins remain owned by terminal-mux.
- 模型请求失败需报告原错误，不改模型或读取凭据绕过。Report model failures; do not switch models or extract credentials to bypass them.
- 使用包级 `npm run check`；未实际验证 Pi/终端/模型时标记 `NOT_RUN`。Run package checks; mark real Pi, terminal and model smoke tests `NOT_RUN` unless performed.
