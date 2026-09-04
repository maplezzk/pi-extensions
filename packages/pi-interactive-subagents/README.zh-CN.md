# pi-interactive-subagents

为 [pi](https://github.com/badlogic/pi-mono) 提供异步交互式子 agent —— 在终端复用器分屏中启动、编排和管理子会话。**完全非阻塞**：子 agent 在后台运行时，主 agent 可继续工作。

> **Fork 说明：** 本包 fork 自 [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)（MIT 协议）。设计与实现的版权归原作者 **HazAT** 所有。本 fork 的变更：monorepo 集成与 scoped npm 发布。完整文档见 [README.md](./README.md)。

## 工作原理

调用 `subagent()` 后**立即返回**，子 agent 在自己的终端分屏中运行。输入框上方的实时 widget 展示所有运行中的 agent 及其状态（`starting`、`active`、`waiting`、`stalled`、`running`）。子 agent 完成后，结果以异步通知形式**回流**到主会话，触发新一轮处理。完成提醒仅在模型正常停止后注入；用户手动终止或提供方异常不会触发。

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "分析 auth 模块" });
subagent({ name: "Scout: DB", agent: "scout", task: "梳理数据库 schema" });
// 两者立即返回，结果各自独立回流
```

## 安装

```bash
pi install npm:@maplezzk/pi-interactive-subagents
```

支持的终端复用器：[cmux](https://github.com/manaflow-ai/cmux)、[tmux](https://github.com/tmux/tmux)、[zellij](https://zellij.dev)、[WezTerm](https://wezfurlong.org/wezterm/)、[herdr](https://herdr.dev)、[Otty](https://otty.sh)、[Orca](https://orca.dev)。

在其中启动 pi：

```bash
cmux pi
# 或
tmux new -A -s pi 'pi'
# 或
zellij --session pi   # 然后运行 pi
```

可选：设置 `PI_SUBAGENT_MUX=muxy|cmux|tmux|zellij|wezterm|herdr|otty|orca` 强制指定后端。Herdr 默认保持原有分屏布局；设置 `PI_SUBAGENT_HERDR_MODE=tab` 后每个 subagent 创建独立后台 Tab，设置为 `split` 可显式选择分屏模式。

也可以在 Pi 内通过 `/config:subagent` 配置：不带参数打开选择菜单，或直接运行
`/config:subagent auto|muxy|cmux|tmux|zellij|wezterm|herdr [split|tab]|otty|orca`。例如 `/config:subagent herdr tab` 会同时持久化 Herdr 后端与 Tab 模式。选择会保存到 Pi 的用户扩展配置目录；显式设置的 `PI_TERMINAL_MUX` / `PI_SUBAGENT_MUX` 与 `PI_SUBAGENT_HERDR_MODE` 优先级更高。`/subagent-config` 和 `/pi-subagent-config` 仍作为兼容别名保留。

## 主要能力

- **4 个主会话工具 + 2 个命令**：`subagent`、`subagent_interrupt`、`subagents_list`、`subagent_resume`；命令 `/plan`、`/subagent`
- **内置 agent**：planner、scout、worker、reviewer、visual-tester
- **`/plan` 工作流**：调研 → 规划 → 确认 → 执行 → 审查 的完整流水线
- **caller_ping**：子 agent 向父 agent 求助的机制
- **自定义 agent**：在 `.pi/agents/` 或 `~/.pi/agent/agents/` 放置 `.md` 定义文件

完整的参数、frontmatter 字段、工具访问控制、Role Folders 等说明见 [README.md](./README.md)。

## 配置

持久化的 Herdr 模式、子 agent 创建策略和子 agent 扩展列表读取自用户扩展配置 `~/.pi/agent/extensions/pi-interactive-subagents/config.json`（遵循 `PI_CODING_AGENT_DIR`）。状态面板的 `status.enabled` 读取已安装包目录的 `config.json`，不存在时回退到 `config.json.example`。`config.json.example` 仅用于说明字段；向用户配置添加 `allowSubagentSpawning` 和 `subagentExtensions` 时不要覆盖已有的 mux 设置：

```json
{
  "herdrMode": "split",
  "allowSubagentSpawning": false,
  "subagentExtensions": [],
  "status": {
    "enabled": true
  }
}
```

`herdrMode` 支持 `split`（默认，兼容原有 pane 布局）和 `tab`（每个 subagent 独立后台 Tab）。`allowSubagentSpawning` 是全局开关，控制子 agent 是否可以创建或管理其他 subagent，默认值为 `false`；设置为 `true` 后，子 agent 才会获得这些生命周期工具。`subagentExtensions` 是可选扩展路径列表；子 agent 不再自动发现项目级和全局扩展，只加载列表中的扩展，`subagent-done.ts` 始终加载。路径可以是绝对路径、`~/` 路径，或相对于 `PI_CODING_AGENT_DIR` 的路径。`/config:subagent herdr split|tab` 会更新 Herdr 字段。

## 致谢

- 原作者 **HazAT** 的设计与实现（[原始仓库](https://github.com/HazAT/pi-interactive-subagents)）
- 子 agent 状态监督与 turn 级中断功能受 [RepoPrompt](https://repoprompt.com/) 启发

## 许可证

MIT
