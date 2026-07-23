# pi-interactive-subagents

为 [pi](https://github.com/badlogic/pi-mono) 提供异步交互式子 agent —— 在终端复用器分屏中启动、编排和管理子会话。**完全非阻塞**：子 agent 在后台运行时，主 agent 可继续工作。

> **Fork 说明：** 本包 fork 自 [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)（MIT 协议）。设计与实现的版权归原作者 **HazAT** 所有。本 fork 的变更：monorepo 集成与 scoped npm 发布。完整文档见 [README.md](./README.md)。

## 工作原理

调用 `subagent()` 后**立即返回**，子 agent 在自己的终端分屏中运行。输入框上方的实时 widget 展示所有运行中的 agent 及其状态（`starting`、`active`、`waiting`、`stalled`、`running`）。子 agent 完成后，结果以异步通知形式**回流**到主会话，触发新一轮处理。

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "分析 auth 模块" });
subagent({ name: "Scout: DB", agent: "scout", task: "梳理数据库 schema" });
// 两者立即返回，结果各自独立回流
```

## 安装

```bash
pi install @maplezzk/pi-interactive-subagents
```

支持的终端复用器：[cmux](https://github.com/manaflow-ai/cmux)、[tmux](https://github.com/tmux/tmux)、[zellij](https://zellij.dev)、[WezTerm](https://wezfurlong.org/wezterm/)、[herdr](https://herdr.dev)、[Otty](https://otty.sh)。

在其中启动 pi：

```bash
cmux pi
# 或
tmux new -A -s pi 'pi'
# 或
zellij --session pi   # 然后运行 pi
```

可选：设置 `PI_SUBAGENT_MUX=cmux|tmux|zellij|wezterm|herdr|otty` 强制指定后端。

## 主要能力

- **4 个主会话工具 + 3 个命令**：`subagent`、`subagent_interrupt`、`subagents_list`、`subagent_resume`；命令 `/plan`、`/iterate`、`/subagent`
- **内置 agent**：planner、scout、worker、reviewer、visual-tester
- **`/plan` 工作流**：调研 → 规划 → 确认 → 执行 → 审查 的完整流水线
- **`/iterate` 工作流**：fork 当前会话到子 agent 做快速修改，不污染主上下文
- **caller_ping**：子 agent 向父 agent 求助的机制
- **自定义 agent**：在 `.pi/agents/` 或 `~/.pi/agent/agents/` 放置 `.md` 定义文件

完整的参数、frontmatter 字段、工具访问控制、Role Folders 等说明见 [README.md](./README.md)。

## 配置

状态显示由扩展目录下的 `config.json` 控制。复制 `config.json.example` 开始：

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  }
}
```

## 致谢

- 原作者 **HazAT** 的设计与实现（[原始仓库](https://github.com/HazAT/pi-interactive-subagents)）
- 子 agent 状态监督与 turn 级中断功能受 [RepoPrompt](https://repoprompt.com/) 启发

## 许可证

MIT
