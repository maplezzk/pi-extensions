# pi-hud

Heads-up session timing for the [Pi coding agent](https://github.com/earendil-works/pi): a live elapsed timer in the working spinner plus per-turn and total run summaries in the chat flow.

[中文文档](./README.zh-CN.md)

## Features

- While the agent is working, the spinner shows the **total elapsed time since you sent the message** (for example `⏱ 47s`). It keeps counting across turns instead of resetting per turn.
- When each turn ends, a dim line shows that turn's precise duration (`⏱ Turn elapsed 8.2s`).
- When the agent fully settles (`agent_settled` — including auto-retries, compaction continuations, or Esc interruption), a final line shows the **total elapsed time from message send to stop** (`⏱ Total elapsed 18.9s`).

## Install

```bash
pi install npm:pi-hud
```

## How it works

- The total timer starts on the `input` event (the moment you submit a message) and ends on `agent_settled`, so multi-turn tool calls, automatic retries, and queued continuations are all covered. Steer/follow-up messages sent mid-run do not reset the start point.
- In non-TUI mode (rpc/print) the timer and notifications are disabled.

## Localization

All user-facing text is provided in `zh-CN` and `en-US` through `pi-extensions-i18n`.
