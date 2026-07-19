# pi-tool-supervisor

`pi-tool-supervisor` 是 Pi 的编辑后审查扩展。它会根据 `edit` 或 `write` 实际产生的文件变化，对照项目规则执行审查，并把结构化审计结果返回给 Agent。

## 解决什么问题

编辑工具成功执行，并不代表结果符合项目约定、架构边界、安全规则或任务要求。对真实的前后文件 diff 执行模型审查，可以及时发现这些问题，同时把审查策略保留在项目可配置的规则文件中。

## 工作方式

- 在 `edit` / `write` 前捕获文件状态，在工具返回后读取实际文件状态。
- 构建 diff，并只选择规则文件匹配当前变更文件的 reviewer。
- 支持多个 reviewer 并行执行，每个 reviewer 可以使用自己的模型和一个或多个规则文件。
- 读取规则文件可选的 front matter：`enabled`、`filePatterns`、`complexity` 和 `consumers`。
- 返回 `passed`、`rejected`、`failed` 或 `skipped` 状态，以及结论、发现、规则组和耗时。
- 每次 edit/write 都重新读取配置，因此配置修改会在下一次操作立即生效。
- 当前 Pi 展示中间件可用时显示审计卡片，否则使用 fallback renderer。

它监听 Pi 原生事件，不会注册替代版 `edit` 或 `write` 工具。

## 安装

```bash
pi install npm:pi-tool-supervisor
```

安装后重新加载 Pi：

```text
/reload
```

使用交互式配置命令：

```text
/pi-tool-supervisor
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
  "maxOutputChars": 10000,
  "maxRuleLines": 100,
  "reviewers": [
    {
      "name": "project-rules",
      "model": "provider/model",
      "rulesFiles": [
        "/absolute/path/to/rules.md"
      ]
    }
  ]
}
```

每个 reviewer 必须提供 `provider/model` 格式的模型，并提供 `rulesFile` 或 `rulesFiles`。相对规则文件路径按当前项目工作目录解析。

| 配置项 | 含义 |
| --- | --- |
| `enabled` | 启用或关闭审查层。 |
| `timeoutSeconds` | 每个 reviewer 模型调用的最长等待时间。 |
| `maxOutputChars` | 工具结果最大返回长度，超出后写入临时文件。 |
| `maxRuleLines` | 单条审查规则允许读取的最大行数。 |
| `reviewers` | reviewer 名称、模型、规则文件和可选匹配条件。 |

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

## 审查语义

- 审查拒绝会追加到工具结果并列出发现；Agent 应先处理这些问题再继续。
- reviewer 调用失败会标记为审查未完成，但会放行原始编辑结果。
- 工具调用失败或文件内容没有变化时跳过审查。
- 扩展不会回滚编辑、阻断操作系统，也不替代 Pi 的权限与沙箱控制。

从 `pi-file-edit-review` 升级时，如果新配置不存在，扩展会读取旧配置；通过 `/pi-tool-supervisor` 保存后会写入新的配置路径。

## 要求

- Node.js 22 或更高版本。
- 每个启用 reviewer 都需要一个已配置的 Pi 模型。
- 需要提供描述项目级检查项的规则文件。

## 许可证

[MIT](../../LICENSE)
