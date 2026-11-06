---
name: configure-pi-safety-guards
description: "配置安全规则、规则动作和自定义匹配器。Use when configuring safety rules, rule actions or custom matchers."
---

# 配置安全规则 / Configure safety rules

## 配置位置 / Location

`<pi-agent-dir>/extensions/pi-safety-guards/config.json`

遵守 `PI_CODING_AGENT_DIR`。首次运行时如果文件不存在，插件会把 4 条默认规则写进该文件；之后只读这个文件，没有隐藏的内置规则。`/config:safety-guards`（等价于 `show`）打印配置文件路径和当前生效规则，不打开菜单、不改文件；改完执行 `/reload`。
Respect `PI_CODING_AGENT_DIR`. On first run the extension writes four default rules into that file when it is missing, and reads only that file afterwards; no rules are hidden in code. `/config:safety-guards` (same as `show`) prints the file path and effective rules without opening a menu or writing files; reload after editing.

## 规则 / Rules

- 顶层只有 `rules` 数组；数组为空就是没有任何保护。Only `rules` is accepted at the top level; an empty list means no protection.
- 每条规则必须写 `id`、`action`、`match`；`message` 可选，`enabled: false` 表示保留但不执行（仍要写全 id/action/match）。Every rule needs `id`, `action` and `match`; `message` is optional and `enabled: false` keeps a rule without running it (it still needs a complete id/action/match).
- ID 在列表内不能重复；未知字段直接报错，不静默忽略。IDs must be unique; unknown fields are rejected instead of silently ignored.
- `action`：`warn`、`confirm`、`block`，优先级递增。Actions in increasing priority.
- `match`：`commands`、`commandPrefixes`、`commandPattern`、`outsideRoots`、`module`，选择一种，匹配内容都写在 JSON 里。Choose one explicit matcher; the matching content lives in the JSON.
- 目录限制写成 `{ "id": "paths.workspace", "action": "block", "match": { "outsideRoots": ["."] } }`。Write directory restrictions as that rule shape.
- 预设（`presets` 字段和 `presets/` 目录）已删除，出现 `presets` 字段会报错并提示改成 `rules`。Presets (the `presets` field and the `presets/` directory) were removed; a `presets` field now fails with a message pointing at `rules`.

字段说明和示例见 [README](./README.zh-CN.md) 与 [配置示例](./config.example.json)。
See the [English README](./README.md) and [configuration example](./config.example.json) for details.

## 自定义模块 / Custom modules

使用显式指定的可信本地 ES 模块，默认导出函数并返回布尔值。模块接收冻结的命令摘要；加载和异步匹配 5 秒超时。同进程代码不是沙箱，不能通过超时中止同步死循环。

Use a trusted local ES module that default-exports a boolean matcher over the frozen command summary. Loading and asynchronous matching have a five-second deadline. Same-process modules are not sandboxed; the deadline cannot stop synchronous loops.

## 验证与排错 / Verify and troubleshoot

- 配置后检查规则 ID、动作及目录根是否符合预期；`/config:safety-guards show` 会列出文件路径和生效规则，停用的规则显示“已停用”。Check IDs, actions and directory roots; `/config:safety-guards show` lists the file path and effective rules, marking disabled ones.
- 无 UI 时 confirm 会阻断；warn 附加到对应工具结果。Without a UI, confirm blocks; warn appears in the corresponding tool result.
- 配置、解析或规则失败时查看错误原因，修复后重试；修改配置或模块后 reload。Inspect failures, fix the cause and retry; reload after configuration or module changes.
- 运行 `npm run check` 验证代码；单元测试不替代真实 Pi 交互确认。Run code checks; unit tests do not replace interactive Pi verification.
