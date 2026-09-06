---
name: configure-pi-safety-guards
description: "配置安全预设、规则动作和自定义匹配器。Use when configuring safety presets, rule actions or custom matchers."
---

# 配置安全规则 / Configure safety rules

## 配置位置 / Location

`<pi-agent-dir>/extensions/pi-safety-guards/config.json`

遵守 `PI_CODING_AGENT_DIR`，修改后执行 `/reload`。
Respect `PI_CODING_AGENT_DIR` and run `/reload` after changes.

## 选择规则 / Select rules

默认 `destructive-operations` 对支持的删除、格式化、所有权修改和 fork bomb 操作要求确认。需要限制目录时选择 `workspace-boundary`。

The default `destructive-operations` preset asks for confirmation for supported deletion, formatting, ownership and fork-bomb operations. Select `workspace-boundary` for directory restrictions.

- `presets`：选择预设；`[]` 不选择预设。Select presets; `[]` selects none.
- `rules`：按 ID 覆盖或添加；`enabled: false` 禁用已有规则。Override or add by ID; use `enabled: false` to disable a rule.
- `action`：`warn`、`confirm`、`block`，优先级递增。Actions in increasing priority.
- `match`：`commands`、`detector`、`outsideRoots`、`module`，选择一种。Choose one matcher.
- `message`：可选说明，支持文本或中英文对象。Optional text or bilingual message object.

字段说明和示例见 [README](./README.zh-CN.md) 与 [配置示例](./config.example.json)。
See the [English README](./README.md) and [configuration example](./config.example.json) for details.

## 自定义模块 / Custom modules

使用显式指定的可信本地 ES 模块，默认导出函数并返回布尔值。模块接收冻结的命令摘要；加载和异步匹配 5 秒超时。同进程代码不是沙箱，不能通过超时中止同步死循环。

Use a trusted local ES module that default-exports a boolean matcher over the frozen command summary. Loading and asynchronous matching have a five-second deadline. Same-process modules are not sandboxed; the deadline cannot stop synchronous loops.

## 验证与排错 / Verify and troubleshoot

- 配置后检查预设和规则 ID、动作及目录根是否符合预期。Check selected presets, IDs, actions and directory roots.
- 无 UI 时 confirm 会阻断；warn 附加到对应工具结果。Without a UI, confirm blocks; warn appears in the corresponding tool result.
- 配置、解析或规则失败时查看错误原因，修复后重试；修改配置或模块后 reload。Inspect failures, fix the cause and retry; reload after configuration or module changes.
- 运行 `npm run check` 验证代码；单元测试不替代真实 Pi 交互确认。Run code checks; unit tests do not replace interactive Pi verification.
