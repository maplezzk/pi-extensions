# Rename outputPrompt to outputRequest

## 状态

`completed`

## 范围

将 `packages/pi-distill` 注入到所有受控工具参数 schema 中的字段名从 `outputPrompt` 改为 `outputRequest`。

影响面：
- `packages/pi-distill` 源码、locale、测试
- `packages/pi-distill/README.md` 与 `README.zh-CN.md`
- 下游 Pi 用户的工具调用契约（破坏性变更）

## 启动方式

用户主动选择方案 B：字段名也改。已确认关键决策。

## 已确认决策

| 问题 | 用户答案 | 推荐 |
|---|---|---|
| 新字段名 | `outputRequest` | ✅ 一致 |
| 旧字段兼容 | 不兼容，直接移除 | 用户明确选择 |
| `outputMode` 拆分 | 本次不改 | ✅ 保持范围最小 |
| 波及其它包 | 只检查 pi-tool-supervisor 等；确认无代码读取 | 已检查：pi-tool-supervisor 无代码引用；pi-extensions-tool-display 测试数据需更新 |

## 术语结果

- `outputRequest`：调用者请求工具返回的内容；必填字符串；`RAW` 表示请求原始输出；其它非空值表示请求摘要。

## ADR 判断

本决策涉及公开 API 字段名变更，难以逆转且会影响下游调用者，满足 ADR 三条件（难以逆转、缺上下文费解、存在真实取舍）。应在 plan 阶段输出轻量 ADR：`docs/adrs/2025-01-21-rename-outputprompt-to-outputrequest.md`。

## 未定 / 阻塞

无。
