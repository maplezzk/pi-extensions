# pi-auto-goal

Stop-guard for Pi: when the agent stops, a second model judges whether the stop is premature and continues the task in your voice.

[中文](./README.zh-CN.md)

## What it does

Pi can finish a turn while a multi-step request is only half done: the agent edits one file, reports progress, and stops. `pi-auto-goal` listens for `agent_settled` — the moment Pi is certain it will not continue on its own — and asks a second model one question: **was stopping here acceptable, or is work still missing?**

When the verdict is "still missing" with enough confidence, the extension sends a stern user-voice message that names the gap and tells the agent to keep going. Otherwise it stays quiet and the turn ends normally.

## Installation and usage

```bash
pi install npm:pi-auto-goal
```

Run `/reload` after installing; configuration changed through `/config:auto-goal` takes effect immediately, while editing the config file by hand still needs `/reload`.

Every fully settled turn is judged (unless `enabled` is false), so a single-line question also costs one judge call. Judged contexts:

- **User request**: the last real user input on the current branch. Messages injected by this extension are skipped, so repeated interventions still judge against your original request.
- **User answers**: when the agent asked you with `ask_user_question`, the answers you gave (stored as tool results, not user messages). They count as user input for the round, and the judge prompt makes them outrank the original request: an answer that narrows the scope, picks an option, or asks to stop first makes stopping a normal ending. One answer is truncated at `maxUserAnswerChars` (default `2000`).
- **Final output**: the agent's last text output of this round.
- **Tool trace** (optional, off by default via `includeToolTrace`): tool calls made since that user input, condensed to one line each. It is not sent by default, so verdicts rest on the text blocks above.

The judge never sees your other session branches.

## Safety rules

- **Bounded interventions**: `maxAutoContinues` (default `2`) caps automatic continuations per user request. Your own new input resets the counter. Reaching the cap produces a single warning and stops intervening.
- **No interruption of your typing**: the verdict is discarded if you started a new turn, queued a message, or the branch moved while the judge was running.
- **Conservative verdicts**: the built-in judge prompt treats thin evidence, polite closings, and analysis-only output as incomplete, and falls back to "stop" when the evidence is ambiguous.
- **Waiting on background work counts as normal waiting**: when the agent's final output says it is waiting on background work (for example it just started `subagent`, `subagent_resume`, or `workflow` and said the result arrives automatically), the judge prompt requires a "stop" verdict. The background work wakes the session when it finishes, so a continuation would only add an extra round; this rule outranks the other verdict rules, and it reads the agent's final output rather than the tool trace.
- **Explicit failures**: judge, authentication, timeout, and send errors are reported in the UI; a failed judgement is never treated as an acceptable stop.
- **Persistent sessions only**: judgement runs in TUI and RPC modes. Print and JSON modes skip it, because the session already shuts down once the agent settles and an automatic continuation could never execute.

## Configuration

File: `<pi-agent-dir>/extensions/pi-auto-goal/config.json`; respects `PI_CODING_AGENT_DIR`. Start from [`config.example.json`](./config.example.json).

```json
{
  "enabled": true,
  "model": "",
  "maxAutoContinues": 2,
  "confidenceThreshold": 0.6,
  "timeoutSeconds": 30,
  "includeToolTrace": false,
  "maxUserRequestChars": 2000,
  "maxFinalOutputChars": 4000,
  "maxToolTraceEntries": 20,
  "maxUserAnswerChars": 2000,
  "notifyOnStopDecision": false,
  "showVerdictNotice": true,
  "judgeMaxTokens": 2000,
  "continueMessageTemplate": "",
  "forcedDecision": "auto"
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when false no judge call is made. |
| `model` | `""` | Judge model as `provider/modelId`; empty reuses the current session model. Pick it from the `/config:auto-goal` menu, or set it with `/config:auto-goal model <provider/modelId>`. |
| `maxAutoContinues` | `2` | Interventions per user request; `0` means unlimited. |
| `confidenceThreshold` | `0.6` | Minimum confidence required to intervene. |
| `timeoutSeconds` | `30` | Judge request timeout; a timeout is reported, not treated as a stop. |
| `includeToolTrace` | `false` | Send this round's tool-call trace to the judge. Off by default: verdicts should come from the user request and the agent's final output. |
| `maxUserRequestChars` | `2000` | Truncation limit for the user request. |
| `maxFinalOutputChars` | `4000` | Truncation limit for the agent's final output. |
| `maxToolTraceEntries` | `20` | Maximum tool-trace lines. |
| `maxUserAnswerChars` | `2000` | Truncation limit for one user answer (an `ask_user_question` reply). |
| `notifyOnStopDecision` | `false` | Deprecated: one verdict block is emitted per turn, so this switch no longer has any effect (the field stays accepted so old configs keep working). |
| `showVerdictNotice` | `true` | Show the latest verdict as a filled notice block in the transcript, below the message (details expand with Ctrl+O). |
| `judgeMaxTokens` | `2000` | Output-token ceiling for one judge call, clamped to the model's own output limit. |
| `continueMessageTemplate` | `""` | Overrides the built-in message; supports `{reason}`. |
| `forcedDecision` | `"auto"` | Override verdict for controlled experiments: `auto` (normal), `continue` (always treat as premature stop), `stop` (always treat as acceptable stop). |

Unknown fields and invalid values are rejected with an explicit error instead of being silently ignored.

### How to tell whether it fired

After each turn the transcript shows **one** filled `[auto-goal]` block below the message with the verdict (`showVerdictNotice`, on by default):

| Verdict line | Colour | Meaning |
| --- | --- | --- |
| `⚖️ stop accepted · confidence 92%` | green | Judged as a normal stop; no intervention. The reason sits in the expandable details (`Ctrl+O`, or click the block in fullscreen mode). |
| `⚖️ judged premature · continuation 1/2` | yellow | Judged as a premature stop; the continuation was sent (1/2 = 1 sent, limit 2). |
| `⚖️ continuation limit reached (2/2) · no further intervention` | grey | Intervention budget for this request is used up. |
| `⚖️ interrupted · not judged` | grey | You pressed Esc; the judgement stood down. |
| `⚖️ turn did not finish normally · not judged` | grey | The turn ended with a failure or a truncated record. |
| `⚖️ judge failed` | red | The judge call failed. |

The body is a single line; the reason, the continuation that was sent, the failure, and the stop reason are kept in the expandable details: press **`Ctrl+O`** (the tool-output toggle), or click the notice block in fullscreen mode, to read them. They take no space while collapsed.

The verdict never enters the LLM context and is not written to the footer status bar; it is a local session entry, so it still renders the same way when you reopen the session.

### Which turns get judged

Only turns that finished normally: the last assistant message ends with `stop` (the agent finished its turn) or `length` (output hit the length cap).

When you press Esc, the turn ends with `aborted` or `error` and empty content — that is your decision, not the agent's stop decision. Such turns used to be judged as "premature stop" and continued automatically, so pressing Esc looked like it did nothing; now they are never judged and only get an "interrupted · not judged" line.

> If you still see the old behaviour (a continuation right after Esc), check that the running session started after the fix: extensions are not hot-reloaded in a live process, so run `/reload` or start a new session.

Two things have to hold for "this turn was not judged": the status line still shows the previous verdict, and no new notification appeared. Typical reasons are a non-tui/rpc mode, you already started typing, or one of those two non-judged endings.

The same verdict now produces one single block (a one-line body plus `Ctrl+O` details) and no extra notification; `notifyOnStopDecision` is deprecated (the field is still accepted so old configs keep working, but it no longer has any effect). Colours are only added in TUI mode, so other modes never see raw ANSI.

### Why the judge no longer answers with an empty response

The judge only needs one JSON verdict, but reasoning models spend output budget on thinking first. `judgeMaxTokens` used to be a fixed 400: once thinking consumed it, the response contained only a thinking block and no text at all, which surfaced as the opaque "unparsable response: (empty response)". Now:

- the judge always runs at the lowest thinking strength (Pi clamps it to the lowest level the model supports, so models that cannot disable thinking still work);
- the output ceiling defaults to 2000 and is configurable through `judgeMaxTokens`;
- a truncated response with no text is retried once with a doubled budget;
- if it still fails, the error carries `stopReason` and a part summary (for example `stopReason=length, parts=thinking:400`) instead of just "empty response".

### Commands

- `/config:auto-goal` — opens the TUI settings panel (aliases: `/auto-goal`, `/pi-auto-goal-config`); it is a settings list with the field name on the left and the current value on the right, a description under the selected row, and one change applied per Enter: judgement, judge model, continue limit, confidence threshold, judge output limit, and the verdict notice. Use `status` for the full field list.
- `/config:auto-goal enable|disable|status|reset` — non-interactive variants; `status` prints the effective configuration and the interventions used in this session.
- `/config:auto-goal model` prints the current judge model; `/config:auto-goal model provider/modelId` sets it; `/config:auto-goal model default` switches back to the current session model.

## Development

```bash
cd packages/pi-auto-goal
npm run typecheck
npm test
npm run check
```

Tests are deterministic: judge calls are injected, so no API key or live model is required.
