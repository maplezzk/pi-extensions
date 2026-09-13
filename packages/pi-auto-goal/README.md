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
- **Final output**: the agent's last text output of this round.
- **Tool trace**: tool calls made since that user input, condensed to one line each.

The judge never sees your other session branches.

## Safety rules

- **Bounded interventions**: `maxAutoContinues` (default `2`) caps automatic continuations per user request. Your own new input resets the counter. Reaching the cap produces a single warning and stops intervening.
- **No interruption of your typing**: the verdict is discarded if you started a new turn, queued a message, or the branch moved while the judge was running.
- **Conservative verdicts**: the built-in judge prompt treats thin evidence, polite closings, and analysis-only output as incomplete, and falls back to "stop" when the evidence is ambiguous.
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
  "includeToolTrace": true,
  "maxUserRequestChars": 2000,
  "maxFinalOutputChars": 4000,
  "maxToolTraceEntries": 20,
  "notifyOnStopDecision": false,
  "showStatusLine": true,
  "judgeMaxTokens": 2000,
  "continueMessageTemplate": "",
  "forcedDecision": "auto"
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when false no judge call is made. |
| `model` | `""` | Judge model as `provider/modelId`; empty reuses the current session model. |
| `maxAutoContinues` | `2` | Interventions per user request; `0` means unlimited. |
| `confidenceThreshold` | `0.6` | Minimum confidence required to intervene. |
| `timeoutSeconds` | `30` | Judge request timeout; a timeout is reported, not treated as a stop. |
| `includeToolTrace` | `true` | Send this round's tool-call trace to the judge. |
| `maxUserRequestChars` | `2000` | Truncation limit for the user request. |
| `maxFinalOutputChars` | `4000` | Truncation limit for the agent's final output. |
| `maxToolTraceEntries` | `20` | Maximum tool-trace lines. |
| `notifyOnStopDecision` | `false` | Also notify when the judge accepts the stop. |
| `showStatusLine` | `true` | Keep the latest verdict as one coloured line in the footer. |
| `judgeMaxTokens` | `2000` | Output-token ceiling for one judge call, clamped to the model's own output limit. |
| `continueMessageTemplate` | `""` | Overrides the built-in message; supports `{reason}`. |
| `forcedDecision` | `"auto"` | Override verdict for controlled experiments: `auto` (normal), `continue` (always treat as premature stop), `stop` (always treat as acceptable stop). |

Unknown fields and invalid values are rejected with an explicit error instead of being silently ignored.

### How to tell whether it fired

The footer always carries one coloured line with the latest verdict (`showStatusLine`, on by default):

| Status line | Colour | Meaning |
| --- | --- | --- |
| `⚖ stop accepted 0.92` | green | Judged as a normal stop; no intervention. |
| `⚖ continued 1/2` | yellow | Judged as a premature stop; the continuation was sent. |
| `⚖ budget exhausted 2/2` | grey | Intervention budget for this request is used up. |
| `⚖ interrupted, not judged` | grey | You pressed Esc; the judgement stood down. |
| `⚖ turn did not finish normally, not judged` | grey | The turn ended with a failure or a truncated record. |
| `⚖ judge failed` | red | The judge call failed (details in the notification). |

### Which turns get judged

Only turns that finished normally: the last assistant message ends with `stop` (the agent finished its turn) or `length` (output hit the length cap).

When you press Esc, the turn ends with `aborted` or `error` and empty content — that is your decision, not the agent's stop decision. Such turns used to be judged as "premature stop" and continued automatically, so pressing Esc looked like it did nothing; now they are never judged and only get a footer line saying "not judged".

Two things have to hold for "this turn was not judged": the status line still shows the previous verdict, and no new notification appeared. Typical reasons are a non-tui/rpc mode, you already started typing, or one of those two non-judged endings.

The same verdict also produces one coloured notification (yellow for intervention, green for an accepted stop, red for failure); `notifyOnStopDecision` controls whether the accepted-stop one is shown. Colours are only added in TUI mode, so other modes never see raw ANSI.

### Why the judge no longer answers with an empty response

The judge only needs one JSON verdict, but reasoning models spend output budget on thinking first. `judgeMaxTokens` used to be a fixed 400: once thinking consumed it, the response contained only a thinking block and no text at all, which surfaced as the opaque "unparsable response: (empty response)". Now:

- the judge always runs at the lowest thinking strength (Pi clamps it to the lowest level the model supports, so models that cannot disable thinking still work);
- the output ceiling defaults to 2000 and is configurable through `judgeMaxTokens`;
- a truncated response with no text is retried once with a doubled budget;
- if it still fails, the error carries `stopReason` and a part summary (for example `stopReason=length, parts=thinking:400`) instead of just "empty response".

### Commands

- `/config:auto-goal` — TUI menu (aliases: `/auto-goal`, `/pi-auto-goal-config`).
- `/config:auto-goal enable|disable|status|reset` — non-interactive variants; `status` prints the effective configuration and the interventions used in this session.

## Development

```bash
cd packages/pi-auto-goal
npm run typecheck
npm test
npm run check
```

Tests are deterministic: judge calls are injected, so no API key or live model is required.
