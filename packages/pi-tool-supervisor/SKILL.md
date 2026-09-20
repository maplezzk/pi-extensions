---
name: configure-pi-tool-supervisor
description: "配置与排查 pi-tool-supervisor 的 before/after 工具审查、reviewer 和规则文件。Use when configuring tool lifecycle reviews."
---

# 配置 pi-tool-supervisor

## 诊断

定位实际 Pi agent 目录下的 `extensions/pi-tool-supervisor/config.json`；仅当新路径不存在时读取旧 `extensions/pi-file-edit-review/config.json`。确认顶层 `enabled`、`timeoutSeconds`、`maxFileContextChars`、`maxRuleLines`、`typesafe`（可选，含 `apiKey` / `endpoint`，未配置时回退到同名环境变量）、`reviewers`。

每个 reviewer 必须有 `provider/model`（`model` 引擎）或 `typesafeModel`（`typesafe` 引擎），以及唯一的 `rulesFile|rulesFiles`，并检查：

- `backend`：`model|typesafe`，省略时为 `model`；
- `typesafeModel`：仅 `typesafe` 引擎使用，默认 `jev-latest`；`typesafe` reviewer 写 `model` 会被忽略并告警；
- `tools`：精确工具名数组，`["*"]` 匹配全部内建和自定义工具；省略时为 `edit/write`；
- `trigger`：`before|after`，省略时为 `after`；
- `condition`：可选本地 TypeScript/ESM 模块路径。模块默认导出函数，收到原生 tool event、`ExtensionContext` 和 `ToolConditionHelpers`；返回 `false` 时跳过 reviewer；
- reviewer `enabled`；
- 规则 frontmatter 的 `enabled`、`filePatterns`、`complexity`、`consumers`；`typesafe` 引擎另外读可选的 `threshold`（默认 `0.85`）。
- **规则文件是引擎无关的，换 backend 不需要改规则。** `typesafe` 引擎直接读文件里现有的编号条款：一条 `1. 正文` 就是一条规则，条款正文既当判据也当 finding 文案，`[error]`/`[warning]` 标注会被剔掉且不分级（命中即阻断）。不要为了 typesafe 去加 `## 判据` / `## 修复提示` / `severity` 字段；那些不是这个后端的要求。
- `## 归属与 severity` 这类元指令段落里的编号条款**不参与判断**，它们讲的是「怎么报告」。段落标题以「归属」开头即识别。
- **编号条款必须写「什么代码算违规」。** 把放行条件（「只读」「只跑脚本或模块」「拿不准就判通过」）写成编号列表，它们照样会被一条一条切成规则，只是问题方向反了；而真正的禁令如果写成了无序列表或散文，反而一条都不会被问。**切得出条款不等于切对了条款**，上一节「切不出编号条款」那道闸门拦不住这种文件。条款一律写禁令，豁免条件写进被豁免的那条条款里。

相对规则文件路径和 condition 模块路径从当前项目 cwd 解析。配置在每次工具调用前重读。

## TypeSafe 引擎排查

`typesafe` reviewer 报 failed 时按顺序看审计里的 `error` 和 `warnings`：

- `没有找到 TypeSafe API key`：`typesafe.apiKey` 和 `TYPESAFE_API_KEY` 都没配；这是失败而非跳过，不会阻断工具。
- `TypeSafe 请求失败（HTTP …）`：401/422 不重试，直接报错；429/529 会按 `retry-after` 退避后重试。
- `切不出编号条款`：规则文件里没有 `1. 正文` 形式的条款（比如整份都是散文，或者用无序列表写的），报 failed 并带文件路径，**不视为通过**。这是启用 typesafe 后规则静默失效的唯一入口，优先看这条。
- `条款切出来是放行条件`：编号列表里写的是「只读」「只跑脚本」这类豁免，每一条都会被当成规则来问，而真正的禁令一条都没进判断。这种情况**不报 failed**，只能拿 `loadReviewRule` 把每个规则文件切出的条款打出来逐条读：是禁令就当规则用，是放行条件就说明文件写错了形状。
- `TypeSafe 没有返回 N 条条款的答案`：这些条款无法判定，整个 reviewer 记为 failed，**不视为通过**。
- `新增行超过 40 行，已跳过行号定位`：只报条款级问题。想恢复行定位就拆小改动。
- `行号定位请求失败`：条款级结论仍然有效，只是没有行号。

一个文件多条规则时，命中的 noul 值逐条列在该 reviewer 的 `summary` 里，形如 `2 条规则命中：必须遵守 1 禁止魔法值=0.92, 必须遵守 4 禁止 any=0.97`；每条命中各自产生一条带规则名的 finding，行定位也是逐条独立请求。规则名就是文件里那条条款的叫法（`{段落} {编号} {粗体标题}`），所以能直接对上文件。

概率判不准时改的是**条款措辞**，不是格式：把豁免条件、边界写清楚。实测「必须提取为有语义的常量」这种带主观词的条款只能给 0.52，而「禁止 `any`」这种边界清楚的给 0.97。`threshold` 是文件级旋钮，实在需要时才调，不要用它去救一条写不清楚的条款。

## 修改

优先使用 `/config:tool-supervisor`；`/pi-tool-supervisor` 是兼容别名。只修改目标 reviewer 和规则：

- `before` 审查工具输入；明确拒绝会阻断原生工具，模型或 TypeSafe 失败、跳过则 fail-open，但错误只保留在审计详情中，不注入 Agent 的 tool result；condition 模块加载或执行失败则阻断 before 调用；
- `after` 审查工具结果；拒绝只诊断、不回滚，原工具失败时跳过 after；
- `edit/write` 使用真实文件前后快照、带真实行号的 diff 和修改后文件上下文；超出 `maxFileContextChars` 时只保留首次与末次变更附近的有界片段并明确标记；其他工具使用有界序列化的 input/result；
- `typesafe` 引擎的 finding 文案就是条款原文（超长时截断），不是模型生成；行号来自第二次 Choice 请求，只有 `after` 且拿得到修改后文件时才有；
- 带 `filePatterns` 的规则只用于文件审查，通用工具规则不要设置 `filePatterns`；
- `complexity: context` 或 `consumers` 不含 `editor-review` 的规则不会被本地审查消费。

规则应可判定、可定位、可修复；超过 `maxRuleLines` 时按主题拆分。TypeSafe 引擎里**一条编号条款对应一条判断**：不要把多条规则堆在同一句里（那会变成一个概率，认不出是哪条命中，行定位也会因候选行分散而降级），也不要为了适配 typesafe 去改规则文件格式。不要把审查扩展描述成 OS 沙箱或回滚机制。

## 验证

先回读配置和所有规则，确认模型、路径、生命周期、condition 模块与文件匹配。再按目标触发一个最小工具调用：before 拒绝应阻断；after 拒绝应保留原结果并附诊断；condition 返回 false 应跳过模型；模型失败应 fail-open、保留审计状态但不注入 Agent。未运行真实工具/模型审查时报告 `NOT_RUN`，不能用 JSON 可解析冒充已生效。
