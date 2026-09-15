# pi-metrics

Session metrics for the [Pi coding agent](https://github.com/earendil-works/pi): a live elapsed timer and token-generation telemetry, with two display timings.

[中文文档](./README.zh-CN.md)

## Features

- While the agent is working, the spinner shows the **total elapsed time since you sent the message** (for example `⏱ 47s`). It keeps counting across turns instead of resetting per turn.
- **Display timing** decides when metric lines appear:
  - `on-stop` (default): the transcript stays quiet during the run. When the agent fully settles (`agent_settled` — including auto-retries, compaction continuations, or Esc interruption), one summary line reports the total elapsed time, blended TPS, TTFT, summed in/out tokens, stalls, and blended cost.
  - `live`: one line per turn, right when the turn ends (the line already carries the turn duration, so no separate elapsed notice is emitted). A multi-turn run also gets a final `⏱` elapsed line.
- Telemetry for every turn is persisted as `tps` custom session entries in both modes, and restored after session resume or `/tree` navigation.
- Metrics are exposed through session entries and notifications. Use `/config:metrics` to open the TUI settings menu, or `/config:metrics enable|disable|live|on-stop|reset` to change a setting directly.

## Configuration

The configuration file is `<pi-agent-dir>/extensions/pi-metrics/config.json`:

```json
{
  "enabled": true,
  "display": "on-stop"
}
```

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `true` / `false` | `true` | Master switch. `false` registers no metric handlers at all. |
| `display` | `"on-stop"` / `"live"` | `"on-stop"` | When metric lines appear: one summary line after the run stops, or one line per turn. |

Use `/config:metrics` for the interactive menu (each selection is saved and the menu reopens until you pick **Done**), or the direct form to change one field. Run `/reload` after editing the file by hand.

## How the summary line is computed

```
⏱ 2m 14.3s · TPS 62.4 tok/s · TTFT 1.2s · in 48.2K · out 12.7K · $0.42/M
```

- **Elapsed** (the `⏱` value opening the line) measures from the moment you submit the message to `agent_settled` — the same clock the spinner has been showing, so the number matches what you watched.
- **TPS** is weighted by output tokens (total output ÷ summed generation time), so a short turn cannot skew the run average.
- **TTFT** is the first measurable value in the run: how long until the first token appeared.
- **in/out** are summed over all turns; **stall** appears only when a stall was detected.
- **Cost rate** is derived from what was actually billed (`billed` cost when a provider reports it, otherwise list price) per million tokens.

## Install

```bash
pi install npm:pi-metrics
```

## How it works

- The total timer starts on the `input` event (the moment you submit a message) and ends on `agent_settled`, so multi-turn tool calls, automatic retries, and queued continuations are all covered. Steer/follow-up messages sent mid-run do not reset the start point.
- `on-stop` mode accumulates each finished turn into a run accumulator that keeps only the aggregated values (no per-turn records), then emits a single line at `agent_settled`. A late billed-cost event recomputes and re-emits that line instead of adding a per-turn line.
- In non-TUI mode (rpc/print) the timer and notifications are disabled.
- The shared Neuralwatt cost listener is unsubscribed during `session_shutdown`, and deferred rehydration notifications are cancelled during reload/session changes.

The TPS implementation is maintained in this package. Remove the standalone `npm:@monotykamary/pi-tps` entry from Pi settings before enabling this package, otherwise both extensions will record duplicate `tps` entries and notifications.

## Localization

All user-facing text is provided in `zh-CN` and `en-US` through `pi-extensions-i18n`.
