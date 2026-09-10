---
name: configure-pi-auto-goal
description: 配置与排查 pi-auto-goal 的提前停止判定、判定模型、干预上限与催促文案。Use when configuring or diagnosing premature-stop judgement.
---

# 配置 pi-auto-goal / Configure pi-auto-goal

读取 `<pi-agent-dir>/extensions/pi-auto-goal/config.json`，遵守 `PI_CODING_AGENT_DIR`。用 `/config:auto-goal` 打开 TUI 菜单，参数 `enable`、`disable`、`status`、`reset` 执行对应动作；保存后执行 `/reload` 生效。

Read `<pi-agent-dir>/extensions/pi-auto-goal/config.json` and respect `PI_CODING_AGENT_DIR`. Use `/config:auto-goal` for the TUI menu, or the `enable`, `disable`, `status`, and `reset` arguments; run `/reload` after saving.

- `enabled` 关闭整个判定，不产生任何模型调用。`enabled` turns off all judgement and model calls.
- `model` 为 `provider/modelId` 时用专用模型判定，留空则复用当前会话模型；模型不存在会明确报错。A non-empty `model` (`provider/modelId`) uses a dedicated judge model; empty reuses the current session model, and a missing model is reported as an error.
- `maxAutoContinues` 限制同一条用户请求的自动干预次数，`0` 表示不限制；用户发出新输入后重置。`maxAutoContinues` caps interventions per user request; `0` means unlimited, and new user input resets it.
- `confidenceThreshold` 是触发干预所需的最低置信度，`notifyOnStopDecision` 决定「可以停止」的判定是否也提示。`confidenceThreshold` is the minimum confidence required to intervene; `notifyOnStopDecision` also reports acceptable stops.
- `includeToolTrace`、`maxUserRequestChars`、`maxFinalOutputChars`、`maxToolTraceEntries` 控制交给判定模型的上下文规模。`includeToolTrace`, `maxUserRequestChars`, `maxFinalOutputChars`, and `maxToolTraceEntries` size the judge context.
- `timeoutSeconds` 超时后中止判定并报告，不视为「可以停止」。`timeoutSeconds` aborts and reports a timed-out judgement instead of treating it as an acceptable stop.
- `print` / `json` 模式不判定：agent 停止后会话即收尾，settled 回调的 ctx 已失效。Print and JSON modes skip judgement because the session already shuts down and the settled ctx is stale.
- `continueMessageTemplate` 覆盖内置催促文案，支持 `{reason}`；缺少占位符时理由会追加到末尾。`continueMessageTemplate` overrides the built-in continuation message and supports `{reason}`; the reason is appended when the placeholder is missing.

判定或发送失败必须报告，不允许静默跳过。Judgement and delivery failures must be reported, never silently skipped.

运行 `npm run check -w pi-auto-goal`。真实模型与真实会话未验证时标记 `NOT_RUN`。

Run `npm run check -w pi-auto-goal`. Mark unperformed real-model and real-session checks `NOT_RUN`.
