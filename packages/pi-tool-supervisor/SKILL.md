---
name: configure-pi-tool-supervisor
description: "配置与排查 pi-tool-supervisor 的 before/after 工具审查、reviewer 和规则文件。Use when configuring tool lifecycle reviews."
---

# 配置 pi-tool-supervisor

## 诊断

定位实际 Pi agent 目录下的 `extensions/pi-tool-supervisor/config.json`；仅当新路径不存在时读取旧 `extensions/pi-file-edit-review/config.json`。确认顶层 `enabled`、`timeoutSeconds`、`maxFileContextChars`、`maxRuleLines`、`reviewers`。

每个 reviewer 必须有 `provider/model`（`model` 引擎）或 `typesafeModel`（`typesafe` 引擎），以及唯一的 `rulesFile|rulesFiles`，并检查：

- `backend`：`model|typesafe`，省略时为 `model`；
- `typesafeModel`：仅 `typesafe` 引擎使用，默认 `jev-latest`；`typesafe` reviewer 写 `model` 会被忽略并告警；
- `tools`：精确工具名数组，`["*"]` 匹配全部内建和自定义工具；省略时为 `edit/write`；
- `trigger`：`before|after`，省略时为 `after`；
- `condition`：可选本地 TypeScript/ESM 模块路径。模块默认导出函数，收到原生 tool event、`ExtensionContext` 和 `ToolConditionHelpers`；返回 `false` 时跳过 reviewer；
- reviewer `enabled`；
- 规则 frontmatter 的 `enabled`、`filePatterns`、`complexity`、`consumers`；
- `typesafe` 引擎的规则 frontmatter 还需要 `severity` 和 `threshold`，以及正文里的 `## 判据`（`true:`/`false:`）和可选 `## 修复提示`。
- 一个规则文件可以写多条规则：每个 `## 规则：<名>` 开一条独立规则，块名就是审计里显示的规则名，块内可用 `severity:` / `threshold:` 覆盖 front matter。文件里没有 `## 规则：` 时整文件算一条规则，行为与旧格式一致。

相对规则文件路径和 condition 模块路径从当前项目 cwd 解析。配置在每次工具调用前重读。

## TypeSafe 引擎排查

`typesafe` reviewer 报 failed 时按顺序看审计里的 `error` 和 `warnings`：

- `没有找到 TypeSafe API key`：环境里没有 `TYPESAFE_API_KEY`；这是失败而非跳过，不会阻断工具。
- `TypeSafe 请求失败（HTTP …）`：401/422 不重试，直接报错；429/529 会按 `retry-after` 退避后重试。
- `缺少「## 判据」段落`：提示里会带上规则名，便于在一个文件多条规则时定位是哪个块。它只让对应规则失效，其他规则照常判断。
- `TypeSafe 没有返回 N 条规则的答案`：这些规则无法判定，整个 reviewer 记为 failed，**不视为通过**。
- `新增行超过 40 行，已跳过行号定位`：只报规则级问题。想恢复行定位就拆小改动。
- `行号定位请求失败`：规则级结论仍然有效，只是没有行号。

- `顶层判据已被忽略`：文件同时有 `## 规则：` 分块和顶层判据段落；把判据写进对应的规则块。

一个文件多条规则时，命中的 noul 值逐条列在该 reviewer 的 `summary` 里，形如 `2 条规则命中：no-swallowed-error=0.97, no-magic-number=0.92`；每条命中各自产生一条带规则名的 finding，行定位也是逐条独立请求。阈值偏低导致误报时，先调对应规则块的 `threshold`，不要直接改 `severity` 成非 error，否则问题会变成只提示不阻断。

## 修改

优先使用 `/config:tool-supervisor`；`/pi-tool-supervisor` 是兼容别名。只修改目标 reviewer 和规则：

- `before` 审查工具输入；明确拒绝会阻断原生工具，模型或 TypeSafe 失败、跳过则 fail-open，但错误只保留在审计详情中，不注入 Agent 的 tool result；condition 模块加载或执行失败则阻断 before 调用；
- `after` 审查工具结果；拒绝只诊断、不回滚，原工具失败时跳过 after；
- `edit/write` 使用真实文件前后快照、带真实行号的 diff 和修改后文件上下文；超出 `maxFileContextChars` 时只保留首次与末次变更附近的有界片段并明确标记；其他工具使用有界序列化的 input/result；
- `typesafe` 引擎的 finding 文案来自规则文件的 `## 修复提示`，不是模型生成；规则没写修复提示时回退到 `true:` 判据描述。行号来自第二次 Choice 请求，只有 `after` 且拿得到修改后文件时才有；
- 带 `filePatterns` 的规则只用于文件审查，通用工具规则不要设置 `filePatterns`；
- `complexity: context` 或 `consumers` 不含 `editor-review` 的规则不会被本地审查消费。

规则应可判定、可定位、可修复；超过 `maxRuleLines` 时按主题拆分。TypeSafe 引擎里一个规则块对应一条判断：一个文件写多条规则时用 `## 规则：<名>` 分块，每条规则各自一句判据，不要把多句判据堆进同一个 `true:`（那会合并成一个概率，认不出是哪条命中，行定位也会因候选行分散而降级）。不要把审查扩展描述成 OS 沙箱或回滚机制。

## 验证

先回读配置和所有规则，确认模型、路径、生命周期、condition 模块与文件匹配。再按目标触发一个最小工具调用：before 拒绝应阻断；after 拒绝应保留原结果并附诊断；condition 返回 false 应跳过模型；模型失败应 fail-open、保留审计状态但不注入 Agent。未运行真实工具/模型审查时报告 `NOT_RUN`，不能用 JSON 可解析冒充已生效。
