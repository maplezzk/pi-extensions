---
title: Rename outputPrompt to outputRequest in pi-distill
type: refactor
status: active
date: 2025-01-21
origin: docs/grills/2025-01-21-rename-outputprompt-to-outputrequest-grill.md
---

# Rename outputPrompt to outputRequest in pi-distill

## Overview

将 `packages/pi-distill` 注入到所有受控工具参数 schema 中的字段名从 `outputPrompt` 改为 `outputRequest`。字段语义不变：必填字符串；`RAW` 表示请求原始输出；其它非空值表示请求对工具结果进行摘要。

## Problem Frame

`outputPrompt` 这个名称偏向“给摘要器的提示”或“输出处理指令”，容易让调用者误以为它是可选配置。改名为 `outputRequest` 后，名称直接表达“调用者请求工具返回什么内容”，与真实语义一致。详见 grill 记录。

## Requirements Trace

- R1. 所有工具 schema 注入的字段名从 `outputPrompt` 改为 `outputRequest`。
- R2. 系统提示（system prompt）中的描述和示例同步改为 `outputRequest`。
- R3. locale 文案中的 key 和描述同步改为 `outputRequest`。
- R4. 中英文 README 文档同步更新字段名和示例。
- R5. 测试用例同步更新字段名和导出常量名。
- R6. 内部诊断字段 `outputSummaryPrompt` 与渲染配置 `showPrompt` 保持不变（本次不拆分 outputMode）。
- R7. 不保留 `outputPrompt` 兼容字段（用户明确选择不兼容）。

## Scope Boundaries

- 只修改 `packages/pi-distill` 包。
- 不修改 `outputMode` 拆分；`RAW` 语义不变。
- 不保留旧字段名兼容。
- 内部诊断 details 字段 `outputSummaryPrompt` 不改，避免扩大范围。

### Deferred to Follow-Up Work

- 拆分 `outputRequest` + `outputMode`：如果后续需要更清晰地区分“请求内容”和“是否摘要”，可再引入 `outputMode`。

## Context & Research

### Relevant Code and Patterns

- `packages/pi-distill/src/index.ts`：核心扩展逻辑，负责在 `session_start` / `before_agent_start` 时扩展工具 schema，在 `tool_call` 时捕获 `outputPrompt`，在 `tool_result` 时处理结果。
- `packages/pi-distill/src/fallback-renderer.ts`：独立渲染器，读取 `details.outputSummaryPrompt` 展示摘要 prompt；不影响工具参数字段名。
- `packages/pi-distill/src/summary-utils.ts`：摘要决策工具，使用 `showPrompt` 渲染配置，与工具参数字段名无关。
- `packages/pi-distill/locales/index.json`：所有用户可见文案。
- `packages/pi-distill/tests/bash-output-summary.test.ts`：schema 注入和事件处理测试。
- `packages/pi-distill/README.md` / `README.zh-CN.md`：公开文档。
- `packages/pi-extensions-tool-display/tests/custom-tool-overrides.test.ts`：测试数据中出现 `outputPrompt` 作为示例工具调用，需要同步更新。

### External References

- 无。

## Key Technical Decisions

**ADR-1. 不保留旧字段名兼容**
- **决策:** 直接移除 `outputPrompt`，schema 只注入 `outputRequest`。
- **备选方案:** 同时接受 `outputPrompt` 和 `outputRequest`，优先使用 `outputRequest`。
- **权衡:** 简化实现和测试；代价是下游调用者必须一次迁移完成。因为用户明确选择不兼容，且当前仍在早期版本，接受一次性 break。
- **可逆性:** 中。如果后续发现必须兼容，可以再发一个 patch 重新接受旧字段名。

**ADR-2. 内部诊断字段保持 `outputSummaryPrompt`**
- **决策:** 不将内部 diagnostics 字段 `outputSummaryPrompt` 改名为 `outputSummaryRequest`。
- **备选方案:** 一起改名以保持一致。
- **权衡:** 该字段是内部审计/渲染使用的诊断信息，不属于公开工具调用契约；改名会影响现有 renderer 和测试，但收益有限。保持范围最小。
- **可逆性:** 易。

## Open Questions

### Resolved During Planning

- 新字段名：`outputRequest`。
- 旧字段兼容：不保留。
- `outputMode` 拆分：本次不做。
- 其它包影响：pi-tool-supervisor 无代码引用；pi-extensions-tool-display 测试数据需更新。

### Deferred to Implementation

- 无。

## Implementation Units

- [ ] U1. **Rename field in pi-distill source code**

**Goal:** 将 `packages/pi-distill/src/index.ts` 中所有工具参数相关的 `outputPrompt` 改为 `outputRequest`。

**Requirements:** R1, R2, R6

**Dependencies:** 无

**Files:**
- Modify: `packages/pi-distill/src/index.ts`

**Approach:**
- 将 `getOutputPrompt` 改名为 `getOutputRequest`。
- 将 `PendingDistillCall.outputPrompt` 改名为 `outputRequest`。
- 将 schema 注入的 property key 和 required key 改为 `outputRequest`。
- 将 `tool_call` / `tool_result` 中的读取和删除逻辑改为 `outputRequest`。
- 保持内部诊断字段 `outputSummaryPrompt` 不变。
- 将注释中的 `outputPrompt` 改为 `outputRequest`。

**Behavior boundary:**
- 工具 schema 中只存在 `outputRequest` 字段；不再存在 `outputPrompt`。
- 系统提示中的示例和规则文本改为 `outputRequest`。
- 底层工具不再收到 `outputRequest`（与现有行为一致，该字段被删除后转发）。

**Acceptance scenarios:**
- Happy path: `bash` 工具 schema 的 `required` 包含 `outputRequest`，`properties` 包含 `outputRequest`（default RAW）。
- Error path: 调用者传入 `outputPrompt` 而没传 `outputRequest` 时，因 `outputRequest` 缺失导致工具调用校验失败（符合不兼容策略）。

**Verification:**
- 运行 `packages/pi-distill` 测试，schema 注入测试通过。

---

- [ ] U2. **Update locale catalog**

**Goal:** 将 locale 中与工具参数字段相关的 key 和文案改为 `outputRequest`。

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `packages/pi-distill/locales/index.json`

**Approach:**
- 将 key `outputPromptDescription` 改为 `outputRequestDescription`。
- 将 key `outputPromptSystemGuideline` 改为 `outputRequestSystemGuideline`。
- 将 key `showPrompt` 改为 `showOutputRequest`（因该 label 显示的是工具参数值）。
- 更新 `bashPromptDescription` 中的描述文字，把其中的 `outputPrompt` 改为 `outputRequest`。
- 保持 `showPrompt` 作为配置 key 用于渲染开关（内部配置名），或改为 `showOutputRequest` 以保持一致。这里选择同步改为 `showOutputRequest`。

**Behavior boundary:**
- 用户看到的设置项标签和系统提示中全部使用 `outputRequest` 术语。
- 渲染开关 label 的语义不变，只是显示名称跟随字段名。

**Acceptance scenarios:**
- 英文系统提示中出现 `outputRequest=RAW` 而不是 `outputPrompt=RAW`。
- 中文描述中不再出现 `outputPrompt` 一词。

**Verification:**
- 运行测试；locale 被正确加载。

---

- [ ] U3. **Update exported constants and fallback renderer label**

**Goal:** 同步更新源码中的导出常量名和渲染器 label。

**Requirements:** R1, R3

**Dependencies:** U2

**Files:**
- Modify: `packages/pi-distill/src/index.ts`
- Modify: `packages/pi-distill/src/fallback-renderer.ts`

**Approach:**
- 将 `OUTPUT_PROMPT_DESCRIPTION` 改名为 `OUTPUT_REQUEST_DESCRIPTION`。
- 将 `BASH_OUTPUT_PROMPT_DESCRIPTION` 改名为 `BASH_OUTPUT_REQUEST_DESCRIPTION`。
- 更新 `fallback-renderer.ts` 中使用的 `i18n.t("prompt")` 为 `i18n.t("outputRequest")`（如果 locale 中有对应 key）。
- 保持 `outputSummaryPrompt` 内部字段名不变。

**Behavior boundary:**
- 导出常量名反映新字段名。
- 渲染器中显示的摘要 prompt 标签保持可读性。

**Verification:**
- 测试通过；构建无错误。

---

- [ ] U4. **Update tests**

**Goal:** 同步更新 `packages/pi-distill` 和 `packages/pi-extensions-tool-display` 测试中的字段名。

**Requirements:** R5

**Dependencies:** U1, U3

**Files:**
- Modify: `packages/pi-distill/tests/bash-output-summary.test.ts`
- Modify: `packages/pi-extensions-tool-display/tests/custom-tool-overrides.test.ts`

**Approach:**
- 将测试中的 `outputPrompt` 字符串替换为 `outputRequest`。
- 将测试导入的 `OUTPUT_PROMPT_DESCRIPTION` 改为 `OUTPUT_REQUEST_DESCRIPTION`。
- 将测试断言中的 `outputSummaryPrompt` 保持不变。
- 检查是否还有其他测试引用 `outputPrompt`。

**Behavior boundary:**
- 测试不再引用 `outputPrompt` 作为工具参数。

**Verification:**
- `npm test` 在 `packages/pi-distill` 和 `packages/pi-extensions-tool-display` 下通过。

---

- [ ] U5. **Update public documentation**

**Goal:** 同步更新中英文 README。

**Requirements:** R4

**Dependencies:** U1, U2

**Files:**
- Modify: `packages/pi-distill/README.md`
- Modify: `packages/pi-distill/README.zh-CN.md`

**Approach:**
- 将 README 中所有 `outputPrompt` 替换为 `outputRequest`。
- 更新表格、示例和说明文字。

**Behavior boundary:**
- 文档中的字段名和示例与代码一致。

**Verification:**
- 手动检查文档中不再出现 `outputPrompt`（除历史 CHANGELOG 外）。

## 执行交接信息

- U1、U2、U3 串行：U2 依赖 U1 完成字段名替换；U3 依赖 U2 完成 locale key 更新。
- U4 与 U1-U3 部分冲突（同一文件），建议在 U1-U3 完成后执行。
- U5 可在 U1-U3 完成后并行执行。
- 集成验证：`npm run typecheck` 和 `npm test`（至少 pi-distill 和 pi-extensions-tool-display）。

## System-Wide Impact

- **API surface parity:** 所有工具参数 schema 统一使用 `outputRequest`；不再注入 `outputPrompt`。
- **Interaction graph:** 仅影响 pi-distill 扩展的事件处理链和 schema 扩展。
- **Unchanged invariants:** 内部诊断字段 `outputSummaryPrompt`、渲染配置 `showPrompt`（配置 key 可能同步改名，但语义不变）、`RAW` 语义、摘要阈值逻辑保持不变。

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 下游用户/其它项目已依赖 `outputPrompt` 字段名 | 用户已明确接受不兼容；在 README 和 CHANGELOG 中显式标注为 BREAKING CHANGE。 |
| 测试遗漏 | 全量运行 `npm test` 和 `npm run typecheck` 后再提交。 |
| locale key 改名后旧 key 残留 | 全仓库 grep `outputPrompt` 确认只剩历史文档和内部诊断字段。 |

## Documentation / Operational Notes

- 在 `packages/pi-distill/CHANGELOG.md` 中新增 BREAKING CHANGE 条目。
- 发布时应升级 major 版本（或按 monorepo 版本策略处理）。

## Sources & References

- Origin document: `docs/grills/2025-01-21-rename-outputprompt-to-outputrequest-grill.md`
- Related code: `packages/pi-distill/src/index.ts`, `packages/pi-distill/src/fallback-renderer.ts`, `packages/pi-distill/locales/index.json`
- Related PRs/issues: #23（outputPrompt 工具调用契约）
