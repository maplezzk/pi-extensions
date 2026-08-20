---
name: configure-pi-dynamic-workflows
description: "配置与排查 pi-dynamic-workflows 的执行后端和异步模式。Use when configuring workflow backend, async mode, or subagent integration."
---

# 配置 pi-dynamic-workflows

## 诊断

读取实际 Pi agent 目录下的 `extensions/pi-dynamic-workflows/config.json`，并检查 `PI_WORKFLOW_BACKEND`、`PI_WORKFLOW_ASYNC`。优先级是 JSON 配置 > 环境变量 > 默认值。

## 修改

优先在 Pi 中运行 `/config:workflow`：

- `backend: "workflow"` 使用内置进程内 agent；
- `backend: "subagent"` 要求 `pi-interactive-subagents` 已安装并加载；
- `async: true` 让 workflow 后台执行并显示实时状态。

`/workflow-config` 和 `/pi-workflow-config` 仅为兼容别名。不要在没有 subagent 扩展时选择 `subagent`，也不要用环境变量覆盖后误以为 JSON 未生效。

## 验证

运行一个最小 workflow，至少包含静态 `meta.phases`、一次 `phase()` 和一次带 JSON Schema 的 `agent()`。若使用 `subagent` 后端，确认 `globalThis.__pi_subagents` 能力已注入；缺失时明确报告配置依赖错误，不静默切回内置后端。
