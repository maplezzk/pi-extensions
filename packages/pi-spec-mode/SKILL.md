---
name: configure-pi-spec-mode
description: "配置与排查 pi-spec-mode 的规格阶段、strict/quick 审批、文档校验、批准哈希和写入守卫。Use when configuring or diagnosing spec-driven development workflow."
---

# 配置 pi-spec-mode

`pi-spec-mode` 没有独立配置文件或配置命令。工作流通过 `/spec` 命令和当前项目的 `.pi/specs/<slug>/` 产物管理；不要编造配置开关、审批方式或自动执行流程。

## 使用

```text
/spec new <slug> [--title "标题"]
/spec use <slug>
/spec status
/spec approve
/spec revise <requirements|design|tasks|verification>
/spec continue
/spec stop
```

- `strict` 模式逐阶段人工审批 requirements、design、tasks 和 verification。
- `quick` 模式自动接受 requirements/design，但 tasks 仍需用户人工审批后才授权实现。
- Agent 完成当前阶段文档后必须调用 `spec_submit`；提交只登记文档哈希，不会自动批准。
- `/spec approve` 只在交互 UI 中通过用户确认产生人工批准；headless 模式不能自动批准。

## 排查

1. 检查 `/spec status` 的当前阶段和机器状态。
2. 确认当前阶段文档位于 `.pi/specs/<slug>/`，不要直接编辑 `state.json`。
3. 批准后如果文档发生修改，插件会检测 SHA-256 变化，清除下游批准并回退到对应阶段草稿。
4. 计划阶段禁止 bash，只允许修改当前阶段文档；实现阶段允许代码写入，但规格目录仍受保护，仅允许更新 `tasks.md`。
5. 验证阶段根据 `tasks.md` 的 Verification 执行检查，把结果写入 `verification.md` 后再调用 `spec_submit`。

## 验证

- 单元验证：在包目录执行 `npm test` 和 `npm run typecheck`。
- 交互验证：创建一个临时 slug，按 strict 或 quick 链路提交、批准、修改文档并观察回退；再执行 `/spec stop` 确认原工具集恢复。
- 未实际运行交互验证时报告 `NOT_RUN`，不能用命令或配置文件存在代替 UI 证据。

## 边界

本扩展只管理规格工作流，不调用 `setModel`/`setThinkingLevel`，不启动 subagent/workflow，也不依赖 Plannotator。
