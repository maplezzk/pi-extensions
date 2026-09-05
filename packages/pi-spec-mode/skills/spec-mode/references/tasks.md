# Tasks 写法

## 结构

```markdown
### TASK-<kebab-capability> · 任务标题

- Depends on: TASK-other | none
- Requirements: REQ-001, REQ-002
- Acceptance: [ ] 可观察的验收
- Verification: <命令或手动检查>
```

## 规则

- TASK ID 唯一且执行开始后不改名。
- 依赖只写"上游未完成就不能安全开始"的直接任务。
- 每个 Must Have 需求至少被一个任务引用。
- 验收须可观察；验证须给出真实命令。
- 任务粒度：一个任务应在一个会话内完成（约 1-4 小时）。
