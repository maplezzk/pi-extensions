# Requirements 写法（EARS）

## 结构

每个需求：

```markdown
### REQ-001 · 需求标题

**User Story:** 作为 [角色]，我想 [能力]，以便 [价值]。

**Acceptance Criteria:**
1. WHEN [事件/触发] THEN 系统 SHALL [明确响应]
2. IF [条件] THEN 系统 SHALL [明确响应]
3. WHILE [持续状态] THEN 系统 SHALL [持续行为]
```

## 规则

- REQ 编号全局唯一，只增不改。
- 每个验收标准必须是可测试的行为，不用模糊词（快速、友好、适当）。
- 同时覆盖正常、边界、错误场景。
- 最后必须包含 `## Out of Scope` 与 `## Glossary`。

## 提交前自检

- [ ] 有 REQ-<n> 标题
- [ ] 每条验收标准含 SHALL
- [ ] 有错误路径验收
- [ ] 有 Out of Scope
