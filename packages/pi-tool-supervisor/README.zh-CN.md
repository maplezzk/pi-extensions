# pi-tool-supervisor

`pi-tool-supervisor` 是 Pi 的可配置工具生命周期审查扩展。它可以在选定工具执行前后按规则审查，并对 `edit`、`write` 使用真实文件变化。

## 解决什么问题

编辑工具成功执行，并不代表结果符合项目约定、架构边界、安全规则或任务要求。对真实的前后文件 diff 执行模型审查，可以及时发现这些问题，同时把审查策略保留在项目可配置的规则文件中。

## 工作方式

- 每个 reviewer 可选择 `tools`、`trigger`，并可选配置本地 `condition` 模块；省略时保持旧默认：`edit`/`write` + `after`，`"*"` 匹配全部内建和自定义工具。
- before reviewer 审查执行前输入，明确拒绝会通过 Pi 原生机制阻断调用；模型审查失败仍 fail-open 且可见，condition 模块加载或执行失败会阻断 before 调用。
- 在 `edit` / `write` 前捕获文件状态，在工具返回后读取实际文件状态。
- 将带真实行号的修改后文件与 diff 一起发送；超过 `maxFileContextChars` 时，截取首次和末次变更附近并明确标记截断。
- 构建 diff，并只选择规则文件匹配当前变更文件的 reviewer。
- 支持多个 reviewer 并行执行，每个 reviewer 可以使用自己的模型和一个或多个规则文件。
- 读取规则文件可选的 front matter：`enabled`、`filePatterns`、`complexity` 和 `consumers`。
- 返回 `passed`、`rejected`、`failed` 或 `skipped` 状态，以及结论、发现、规则组和耗时。
- 原样透传工具结果，不截断，也不把工具输出写入临时文件；输出控制由 Pi 或其他扩展负责。
- 每次工具调用都重新读取配置，因此配置修改会在下一次匹配操作立即生效。
- 当前 Pi 展示中间件可用时显示审计卡片，否则使用 fallback renderer。展示协议由公共运行库 `pi-extensions-tool-display` 提供。

它监听 Pi 原生事件，不会注册替代版 `edit` 或 `write` 工具。

## 安装

```bash
pi install npm:pi-tool-supervisor
```

包清单会把共享依赖 `pi-extensions-tool-display` 作为一个扩展入口加载，不需要额外安装宿主包。

安装后重新加载 Pi：

```text
/reload
```

使用交互式配置命令：

```text
/config:tool-supervisor
```

## 配置

默认配置路径：

```text
~/.pi/agent/extensions/pi-tool-supervisor/config.json
```

可以从 [`config.example.json`](./config.example.json) 开始：

```json
{
  "enabled": true,
  "timeoutSeconds": 10,
  "maxFileContextChars": 50000,
  "maxRuleLines": 100,
  "reviewers": [
    {
      "name": "project-rules",
      "model": "provider/model",
      "rulesFiles": [
        "/absolute/path/to/rules.md"
      ],
      "tools": ["edit", "write"],
      "trigger": "after",
      "condition": "/absolute/path/to/condition.ts"
    }
  ]
}
```

每个 reviewer 必须提供 `provider/model` 格式的模型，并提供 `rulesFile` 或 `rulesFiles`。相对规则文件和 condition 模块路径按当前项目工作目录解析。

| 配置项 | 含义 |
| --- | --- |
| `enabled` | 启用或关闭审查层。 |
| `timeoutSeconds` | 每个 reviewer 模型调用的最长等待时间。 |
| `maxFileContextChars` | 发送给 reviewer 的修改后文件上下文上限，默认 50,000 字符；超大文件仅发送首次和末次变更附近的有界片段并明确标记。 |
| `maxRuleLines` | 单条审查规则允许读取的最大行数。 |
| `reviewers` | reviewer 名称、模型、规则文件、`tools`、`trigger` 和可选的 condition 模块；省略生命周期字段时保持旧的 `edit`/`write` + `after` 行为。 |
| `condition` | 可选的本地 TypeScript/ESM 模块路径。默认导出函数会收到 Pi 原生工具事件、`ExtensionContext` 和 `ToolConditionHelpers`；返回 `false` 时跳过该 reviewer，不调用模型。 |

规则文件可以通过 front matter 限定适用文件或消费者：

```yaml
---
name: TypeScript safety
enabled: true
filePatterns:
  - "**/*.ts"
complexity: local
consumers:
  - editor-review
---
```

`filePatterns` 使用简化 glob：`*` 不跨 `/`，`**` 可以跨目录，任意位置的 `**/` 都可匹配零层或多层目录。反斜杠会归一化为 `/`，开头的 `./` 会被忽略。

### Condition 模块

reviewer 可以将 `condition` 设置为本地 TypeScript 或 ESM 模块路径。相对路径按当前项目工作目录解析，`~` 会按 Pi home 目录展开。模块必须默认导出一个同步或异步函数：

```ts
import type {
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ToolConditionHelpers } from "pi-tool-supervisor";

export default function condition(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  helpers: ToolConditionHelpers,
): boolean {
  if (event.toolName !== "bash") return false;
  const command = event.input.command;
  if (typeof command !== "string") return false;

  // 可以直接使用 Pi 原生 event/context；解析器是可选辅助。
  const ast = helpers.parseBash(command);
  return ast.errors?.length === 0 && ast.commands.some((statement) =>
    statement.command.type === "Command" && statement.command.name?.value === "mvn",
  );
}
```

第一个参数是 `before` reviewer 收到的原始 `tool_call` 事件，或 `after` reviewer 收到的原始 `tool_result` 事件。第二个参数是原生 `ExtensionContext`，condition 模块可以使用其他 Pi 插件能使用的 context 能力。第三个参数提供 `parseBash(source)`。

condition 返回 `false` 时跳过该 reviewer，不读取其规则文件，也不调用模型。模块加载失败、执行失败、返回非 boolean 或超时会生成可见错误；`before` 会将其视为审查门禁失败并阻断工具。需要阻断工具时使用 `trigger: "before"`，`after` 仍然只提供诊断。

## 审查语义

- before reviewer 明确拒绝会阻断 Pi 原生工具调用，并用完整 reason 展示独立审计；模型失败/跳过会放行但保持可见，condition 模块加载或执行失败会阻断 before 调用。
- after 拒绝只提供诊断，不回滚已完成的工具调用；工具失败时跳过 after 审查并保留原始错误。
- 如果用户打断上级 Agent 请求，所有尚未完成的 reviewer 模型请求会一起取消，尚未发起的 reviewer 会跳过；上级中断记为 skipped，而不是模型调用失败。
- 工具调用失败或文件内容没有变化时跳过审查。
- 扩展不会回滚编辑、阻断操作系统，也不替代 Pi 的权限与沙箱控制。

从 `pi-file-edit-review` 升级时，如果新配置不存在，扩展会读取旧配置；通过 `/config:tool-supervisor` 保存后会写入新的配置路径。`/pi-tool-supervisor` 仍作为兼容别名保留。

## 要求

- Node.js 22 或更高版本。
- 每个启用 reviewer 都需要一个已配置的 Pi 模型。
- 需要提供描述项目级检查项的规则文件。

## 许可证

[MIT](../../LICENSE)
