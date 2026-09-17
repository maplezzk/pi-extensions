---
name: configure-pi-auto-goal
description: 配置与排查 pi-auto-goal 的提前停止判定、判定模型、干预上限与催促文案。Use when configuring or diagnosing premature-stop judgement.
---

# 配置 pi-auto-goal / Configure pi-auto-goal

读取 `<pi-agent-dir>/extensions/pi-auto-goal/config.json`，遵守 `PI_CODING_AGENT_DIR`。用 `/config:auto-goal` 打开 TUI 设置面板（设置列表：左边字段名、右边当前值，选中项下面给说明；可改启用判定、判定模型、干预上限、置信度阈值、判定输出上限、判定结论写入会话区；回车改一项并立即存盘生效），参数 `enable`、`disable`、`status`、`reset` 执行对应动作，`model [provider/modelId|default]` 直接读写判定模型，`status` 看全部字段；配置命令改完立即生效，手改文件才需 `/reload`。

Read `<pi-agent-dir>/extensions/pi-auto-goal/config.json` and respect `PI_CODING_AGENT_DIR`. Use `/config:auto-goal` for the TUI settings panel (a settings list with the field name on the left, the current value on the right, and a description under the selected row: judgement, judge model, continue limit, confidence threshold, judge output limit, verdict notice; one Enter applies one change immediately), or the `enable`, `disable`, `status`, `reset`, and `model [provider/modelId|default]` arguments (`status` prints every field); configuration through that command takes effect immediately, while hand-edited files need `/reload`.

- `enabled` 关闭整个判定，不产生任何模型调用。`enabled` turns off all judgement and model calls.
- `model` 为 `provider/modelId` 时用专用模型判定，留空则复用当前会话模型；模型不存在会明确报错。界面上可在 `/config:auto-goal` 面板里从当前可用模型列表选，或 `/config:auto-goal model provider/modelId`（`default` 改回复用会话模型）。A non-empty `model` (`provider/modelId`) uses a dedicated judge model; empty reuses the current session model, and a missing model is reported as an error. Pick it from the `/config:auto-goal` panel, or set it with `/config:auto-goal model provider/modelId` (`default` switches back).
- `maxAutoContinues` 限制同一条用户请求的自动干预次数，`0` 表示不限制；用户发出新输入后重置。`maxAutoContinues` caps interventions per user request; `0` means unlimited, and new user input resets it.
- `confidenceThreshold` 是触发干预所需的最低置信度。`notifyOnStopDecision` 已废弃（每轮只发一条结论块，字段保留但不再起作用）。
  `confidenceThreshold` is the minimum confidence required to intervene. `notifyOnStopDecision` is deprecated (one verdict block per turn; the field is still accepted but has no effect).
- 每个有判定的轮次只发**一条**提示块：正文一行（如「⚖️ 判定可停止 · 置信度 92%」）。判定理由、已发送的催促、失败原因、结束原因都在展开里：`Ctrl+O` 展开，全屏模式下也可以直接点这条提示块切换它自己的展开态。调这个时不要退回多条提示。
  Each judged turn emits exactly **one** notice block: a one-line body (`⚖️ stop accepted · confidence 92%`). The reason, the sent continuation, the failure, and the stop reason live in the expandable details: `Ctrl+O`, or a click on the block in fullscreen mode. Do not go back to multiple notices per turn.
- `includeToolTrace`、`maxUserRequestChars`、`maxFinalOutputChars`、`maxToolTraceEntries` 控制交给判定模型的上下文规模；`includeToolTrace` 默认关闭，判定默认只看用户请求与 agent 最后输出。`includeToolTrace` (off by default), `maxUserRequestChars`, `maxFinalOutputChars`, and `maxToolTraceEntries` size the judge context; by default the judge sees only the user request and the agent's final output.
- `timeoutSeconds` 超时后中止判定并报告，不视为「可以停止」。`timeoutSeconds` aborts and reports a timed-out judgement instead of treating it as an acceptable stop.
- `judgeMaxTokens` 是单次判定调用的输出上限（默认 2000，会被收敛到模型上限）。判定固定使用最低思考强度；若响应被截断且没有文本，会自动翻倍预算重试一次，仍失败则报出 `stopReason` 与内容块摘要。`judgeMaxTokens` is the output ceiling for one judge call (default 2000, clamped to the model limit). The judge always runs at the lowest thinking strength; a truncated response without text is retried once with a doubled budget, and a remaining failure reports `stopReason` plus a part summary.
- `showStatusLine` 已改名 `showVerdictNotice`（旧名仍可用）：把最近一次判定结论写进会话区、落在消息下方（默认开，颜色区分：绿=判定可停止、黄=判定该继续、灰=催促次数用尽或未判定、红=判定失败）。结论不进 LLM 上下文，也不再占用页脚状态栏。`showVerdictNotice` (legacy `showStatusLine`) writes the latest verdict into the transcript below the message (on by default; green accepted stop, yellow continuation, grey limit reached or not judged, red failure). Verdicts stay out of the LLM context and no longer use the footer status bar.
- 只判定正常跑完的轮次（结束原因 `stop` 或 `length`）。用户按 Esc 打断（`aborted`/`error`）绝不判定，否则会刚打断就被自动复活，看起来像 Esc 失效。Only turns that finished normally (`stop` or `length`) are judged. A user interrupt (`aborted`/`error`) is never judged, otherwise the agent is revived right after you press Esc and the key looks broken.
- 判定提示词把「输出里说在等后台任务」当作可以停止：agent 的最后输出说明它在等后台任务结果（例如刚启动了 `subagent`、`subagent_resume`、`workflow`，结果稍后自动送回会话）时，必须判 `stop`；该条优先于其它条目，不依赖工具轨迹。
  The judge prompt accepts waiting on background work: when the agent's final output says it is waiting on background work (it just started `subagent`, `subagent_resume`, or `workflow`, and the result is delivered automatically later), the verdict must be `stop`; this rule outranks the others and reads the final output rather than the tool trace.
- `print` / `json` 模式不判定：agent 停止后会话即收尾，settled 回调的 ctx 已失效。Print and JSON modes skip judgement because the session already shuts down and the settled ctx is stale.
- `continueMessageTemplate` 覆盖内置催促文案，支持 `{reason}`；缺少占位符时理由会追加到末尾。`continueMessageTemplate` overrides the built-in continuation message and supports `{reason}`; the reason is appended when the placeholder is missing.

判定或发送失败必须报告，不允许静默跳过。Judgement and delivery failures must be reported, never silently skipped.

运行 `npm run check -w pi-auto-goal`。真实模型与真实会话未验证时标记 `NOT_RUN`。

Run `npm run check -w pi-auto-goal`. Mark unperformed real-model and real-session checks `NOT_RUN`.
