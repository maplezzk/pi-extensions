# pi-metrics

Session metrics for the [Pi coding agent](https://github.com/earendil-works/pi): a live elapsed timer, per-turn summaries, and token-generation telemetry.

[中文文档](./README.zh-CN.md)

## Features

- While the agent is working, the spinner shows the **total elapsed time since you sent the message** (for example `⏱ 47s`). It keeps counting across turns instead of resetting per turn.
- When each turn ends, a dim line shows that turn's precise duration (`⏱ Turn elapsed 8.2s`).
- When the agent fully settles (`agent_settled` — including auto-retries, compaction continuations, or Esc interruption), a final line shows the **total elapsed time from message send to stop** (`⏱ Total elapsed 18.9s`).
- After each LLM turn, a notification reports TPS, TTFT, token counts, generation time, stalls, and blended cost when available.
- Telemetry is persisted as `tps` custom session entries and restored after session resume or `/tree` navigation.
- `/tps-export` exports telemetry JSONL; `/session-export` exports the session JSONL.

## Migration from pi-tps

The TPS implementation is maintained in this package. Remove the standalone `npm:@monotykamary/pi-tps` entry from Pi settings before enabling this package, otherwise both extensions will record duplicate `tps` entries and notifications.

## Install

```bash
pi install npm:pi-metrics
```

## How it works

- The total timer starts on the `input` event (the moment you submit a message) and ends on `agent_settled`, so multi-turn tool calls, automatic retries, and queued continuations are all covered. Steer/follow-up messages sent mid-run do not reset the start point.
- In non-TUI mode (rpc/print) the timer and notifications are disabled.
- The shared Neuralwatt cost listener is unsubscribed during `session_shutdown`, and deferred rehydration notifications are cancelled during reload/session changes.

## Localization

All user-facing text is provided in `zh-CN` and `en-US` through `pi-extensions-i18n`.
