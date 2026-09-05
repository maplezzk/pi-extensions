---
name: spec-mode
description: "Use when: 规格驱动开发 / spec 模式 / 创建规格 / requirements design tasks 文档 / 等待阶段审批后执行。配合 /spec 命令使用：先写当前阶段文档，完成后调用 spec_submit，等待用户批准，禁止提前改代码。"
---

# Spec Mode

本 Skill 与 `pi-spec-mode` 扩展配合：扩展管状态机与守卫，本 Skill 教你怎么写阶段文档。

## 当前阶段

每轮开始先确认当前阶段（可从上下文中 [SPEC MODE - ...] 标记得知）：

- requirements：写 `.pi/specs/<slug>/requirements.md`，用 EARS 格式（见 references/requirements.md）
- design：写 `.pi/specs/<slug>/design.md`，映射全部 REQ（见 references/design.md）
- tasks：写 `.pi/specs/<slug>/tasks.md`，拆分 TASK 并保持可验证（见 references/tasks.md）
- implementation：按 tasks.md 执行，每完成一个任务在回复中加 `[DONE:TASK-id]`
- verification：按任务验证命令执行，写 `.pi/specs/<slug>/verification.md`（见 references/verification.md）

## 硬规则

1. 只编辑当前阶段允许的那一份文档（守卫会拦截其他写入）。
2. 禁止运行 bash（守卫拦截）。
3. 写完文档必须调用 `spec_submit` 提交，不得声称"已批准"。
4. 提交被拒绝（返回硬错误）时，按错误列表修复后再次调用。
5. 等待用户批准：用户会执行 `/spec approve`；如果用户要求修改，用 `edit` 修订后重新提交。
6. 不修改 `.pi/specs/<slug>/state.json`，它由插件管理。
7. 不执行 git 提交流程，不创建分支/PR。

## 引用

- [requirements](references/requirements.md)
- [design](references/design.md)
- [tasks](references/tasks.md)
- [verification](references/verification.md)
