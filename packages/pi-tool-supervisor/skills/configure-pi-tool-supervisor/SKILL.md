---
name: configure-pi-tool-supervisor
description: "配置与排查 pi-tool-supervisor 的 before/after 工具审查、reviewer、规则文件和输出限制。Use when configuring tool lifecycle reviews."
---

# 配置 pi-tool-supervisor

## 诊断

定位实际 Pi agent 目录下的 `extensions/pi-tool-supervisor/config.json`；仅当新路径不存在时读取旧 `extensions/pi-file-edit-review/config.json`。确认顶层 `enabled`、`timeoutSeconds`、`maxOutputChars`、`maxRuleLines`、`reviewers`。

每个 reviewer 必须有 `provider/model` 和唯一的 `rulesFile|rulesFiles`，并检查：

- `tools`：精确工具名数组，`["*"]` 匹配全部内建和自定义工具；省略时为 `edit/write`；
- `trigger`：`before|after`，省略时为 `after`；
- reviewer `enabled`；
- 规则 frontmatter 的 `enabled`、`filePatterns`、`complexity`、`consumers`。

相对规则路径从当前项目 cwd 解析。配置在每次工具调用前重读。

## 修改

优先使用 `/config:tool-supervisor`；`/pi-tool-supervisor` 是兼容别名。只修改目标 reviewer 和规则：

- `before` 审查工具输入；明确拒绝会阻断原生工具，失败或跳过则 fail-open 但保持可见；
- `after` 审查工具结果；拒绝只诊断、不回滚，原工具失败时跳过 after；
- `edit/write` 使用真实文件前后快照和 diff；其他工具使用有界序列化的 input/result；
- 带 `filePatterns` 的规则只用于文件审查，通用工具规则不要设置 `filePatterns`；
- `complexity: context` 或 `consumers` 不含 `editor-review` 的规则不会被本地审查消费。

规则应可判定、可定位、可修复；超过 `maxRuleLines` 时按主题拆分。不要把审查扩展描述成 OS 沙箱或回滚机制。

## 验证

先回读配置和所有规则，确认模型、路径、生命周期与文件匹配。再按目标触发一个最小工具调用：before 拒绝应阻断；after 拒绝应保留原结果并附诊断；模型失败应可见且 fail-open。未运行真实工具/模型审查时报告 `NOT_RUN`，不能用 JSON 可解析冒充已生效。
