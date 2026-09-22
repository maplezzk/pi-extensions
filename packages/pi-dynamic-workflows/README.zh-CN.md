# pi-dynamic-workflows

为 Pi 提供 Claude-Code 风格的动态 workflow 编排能力。

> **Fork 说明：** 本包 fork 自 [michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows)（MIT 协议）。设计与实现的版权归原作者 **michaelliv** 所有。本 fork 的变更：monorepo 集成、i18n 支持、配置方式从环境变量迁移为斜杠命令。

## 功能

- 用纯 JavaScript 脚本定义多 agent 工作流，支持 `meta`、`phase()`、`agent()`、`parallel()`、`pipeline()` 原语
- 通过 acorn AST 解析对 workflow 脚本进行静态校验
- 可选 subagent 后端（依赖 `pi-interactive-subagents`），每个 agent 拥有真实工具访问
- 异步后台执行模式，带实时状态 widget
- 通过 `/config:workflow` 斜杠命令配置（持久化到 JSON）

每个 `agent()` 只在 Workflow 面板中展示。使用 `subagent` 后端时，workflow 会启动真实的
`pi-interactive-subagents` 子会话，但这些 agent 会从 Subagents widget 中隐藏，避免同一批
agent 被列两次；它们在各自的终端分屏中照常运行，也可以正常中断。

## 安装

```bash
pi install npm:@maplezzk/pi-dynamic-workflows
```

## 配置

运行 `/config:workflow` 打开配置面板（执行后端回车开二级列表，异步模式回车原地切换；每改一项立即写盘并生效，不需要 `/reload`）：

- **执行后端**：`workflow`（内置进程内 agent）或 `subagent`（需安装并加载 `pi-interactive-subagents`，每个 agent 拥有真实工具会话）
- **异步模式**：后台运行 workflow，带实时状态 widget

配置持久化到 `~/.pi/agent/extensions/pi-dynamic-workflows/config.json`。异步模式在文件里的字段名仍是 `async`（`{"backend": "workflow", "async": false}`），写盘前会做校验。

环境变量仅作兜底支持：

| 变量 | 值 | 效果 |
|---|---|---|
| `PI_WORKFLOW_BACKEND` | `subagent` | 使用 subagent 后端（兜底） |
| `PI_WORKFLOW_ASYNC` | `true` | 启用异步模式（兜底） |

JSON 配置优先级高于环境变量。

> **注意**：`subagent` 后端依赖 `pi-interactive-subagents` 扩展在运行时向 `globalThis.__pi_subagents` 注入能力。若后端被设为 `subagent` 但该扩展未安装/未加载，workflow 中的每个 `agent()` 都会失败。

## 常见问题

### 报错：subagent 执行后端需要 pi-interactive-subagents 扩展，但当前未加载

**原因**：workflow 的执行后端被设为 `subagent`，但 `pi-interactive-subagents` 扩展未安装或未加载，导致 `globalThis.__pi_subagents` 未注入。

`subagent` 后端可能由以下任一来源触发：

- 环境变量 `PI_WORKFLOW_BACKEND=subagent`
- `/workflow-config` 写入的持久化配置（`~/.pi/agent/extensions/pi-dynamic-workflows/config.json`）

**解决方式（任选其一）**：

1. 安装并加载扩展（继续使用 subagent 后端）：

   ```bash
   pi install npm:@maplezzk/pi-interactive-subagents
   ```

2. 切回内置 `workflow` 后端：运行 `/config:workflow`，将执行后端改为 `workflow`。持久化配置优先级高于环境变量，可覆盖 `PI_WORKFLOW_BACKEND`。
3. 若是通过环境变量启用，移除 shell 配置（如 `.zshrc` / `.zshenv`）中的 `export PI_WORKFLOW_BACKEND=subagent` 后重启 pi。

`/workflow-config` 和 `/pi-workflow-config` 仍作为兼容别名保留。

### 报错：Subagent finished without calling structured_output

**原因**：带 `schema` 的 `agent()` 只有在子 agent 通过 `subagent_done` 结束时才能拿到结果。其他任何退出方式（求助、崩溃、被取消）都不会留下结构化结果，workflow 只能报这一句通用错误，真实原因留在子 session 文件里。

带 `schema` 启动的 agent 是 fire-and-forget：workflow 运行期间没有任何角色能回应求助，因此这些 agent 禁用 `caller_ping`，被阻塞的子 agent 必须把阻塞写进结构化结果（`ok: false`，原因放在 `error`/`notes`）。

**处理方式**：翻 workflow 提示的子 session 文件找原因，或先解除阻塞条件再重跑。不要盲目重试——同一个阻塞会得到同一个错误。

## 用法

```js
// 传给 workflow 工具的脚本：
export const meta = {
  name: 'my_workflow',
  description: '完成某件有用的事',
  phases: [{ title: '阶段 1' }]
};

phase('阶段 1');
const result = await agent('分析代码库', {
  label: '代码分析',
  schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
});
```

## 许可证

MIT — 详见原始仓库。
