---
name: configure-pi-auto-goal
description: 配置与排查 pi-auto-goal 的提前停止判定、判定模型、干预上限与催促文案。Use when configuring or diagnosing premature-stop judgement.
---

# 配置 pi-auto-goal / Configure pi-auto-goal

读取 `<pi-agent-dir>/extensions/pi-auto-goal/config.json`，遵守 `PI_CODING_AGENT_DIR`。用 `/config:auto-goal` 打开 TUI 菜单，参数 `enable`、`disable`、`status`、`reset` 执行对应动作；配置命令改完立即生效，手改文件才需 `/reload`。

Read `<pi-agent-dir>/extensions/pi-auto-goal/config.json` and respect `PI_CODING_AGENT_DIR`. Use `/config:auto-goal` for the TUI menu, or the `enable`, `disable`, `status`, and `reset` arguments; configuration through that command takes effect immediately, while hand-edited files need `/reload`.

- `enabled` 关闭整个判定，不产生任何模型调用。`enabled` turns off all judgement and model calls.
- `model` 为 `provider/modelId` 时用专用模型判定，留空则复用当前会话模型；模型不存在会明确报错。A non-empty `model` (`provider/modelId`) uses a dedicated judge model; empty reuses the current session model, and a missing model is reported as an error.
- `maxAutoContinues` 限制同一条用户请求的自动干预次数，`0` 表示不限制；用户发出新输入后重置。`maxAutoContinues` caps interventions per user request; `0` means unlimited, and new user input resets it.
- `confidenceThreshold` 是触发干预所需的最低置信度，`notifyOnStopDecision` 决定「可以停止」的判定是否也提示。`confidenceThreshold` is the minimum confidence required to intervene; `notifyOnStopDecision` also reports acceptable stops.
- `includeToolTrace`、`maxUserRequestChars`、`maxFinalOutputChars`、`maxToolTraceEntries` 控制交给判定模型的上下文规模。`includeToolTrace`, `maxUserRequestChars`, `maxFinalOutputChars`, and `maxToolTraceEntries` size the judge context.
- `timeoutSeconds` 超时后中止判定并报告，不视为「可以停止」。`timeoutSeconds` aborts and reports a timed-out judgement instead of treating it as an acceptable stop.
- `judgeMaxTokens` 是单次判定调用的输出上限（默认 2000，会被收敛到模型上限）。判定固定使用最低思考强度；若响应被截断且没有文本，会自动翻倍预算重试一次，仍失败则报出 `stopReason` 与内容块摘要。`judgeMaxTokens` is the output ceiling for one judge call (default 2000, clamped to the model limit). The judge always runs at the lowest thinking strength; a truncated response without text is retried once with a doubled budget, and a remaining failure reports `stopReason` plus a part summary.
- `showStatusLine` 已改名 `showVerdictNotice`（旧名仍可用）：把最近一次判定结论写进会话区、落在消息下方（默认开，颜色区分：绿=停止合理、黄=已催促、灰=已达上限或未判定、红=判定失败）。结论不进 LLM 上下文，也不再占用页脚状态栏。`showVerdictNotice` (legacy `showStatusLine`) writes the latest verdict into the transcript below the message (on by default; green accepted stop, yellow continuation, grey budget exhausted or not judged, red failure). Verdicts stay out of the LLM context and no longer use the footer status bar.
- 只判定正常跑完的轮次（结束原因 `stop` 或 `length`）。用户按 Esc 打断（`aborted`/`error`）绝不判定，否则会刚打断就被自动复活，看起来像 Esc 失效。Only turns that finished normally (`stop` or `length`) are judged. A user interrupt (`aborted`/`error`) is never judged, otherwise the agent is revived right after you press Esc and the key looks broken.
- `print` / `json` 模式不判定：agent 停止后会话即收尾，settled 回调的 ctx 已失效。Print and JSON modes skip judgement because the session already shuts down and the settled ctx is stale.
- `continueMessageTemplate` 覆盖内置催促文案，支持 `{reason}`；缺少占位符时理由会追加到末尾。`continueMessageTemplate` overrides the built-in continuation message and supports `{reason}`; the reason is appended when the placeholder is missing.

判定或发送失败必须报告，不允许静默跳过。Judgement and delivery failures must be reported, never silently skipped.

运行 `npm run check -w pi-auto-goal`。真实模型与真实会话未验证时标记 `NOT_RUN`。

Run `npm run check -w pi-auto-goal`. Mark unperformed real-model and real-session checks `NOT_RUN`.
