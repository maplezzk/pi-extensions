# pi-session-tools

Session tooling for the [Pi coding agent](https://github.com/earendil-works/pi): a bash pipe output cache and conversation squashing.

[中文文档](./README.zh-CN.md)

## Features

- When a bash pipeline filters output through `grep`, `tail`, or `head`, the full pre-filter output is written to the system temp directory under `pi-pipe-cache/` and the path is appended to the tool result, so you can re-filter the cached file instead of re-running the command.
- Provides `session_log`: lists your messages in the conversation and the valid squash starting points.
- Provides `session_squash`: squashes the conversation from a chosen message into a summary to free up context. Nothing is deleted; use `/tree` to go back.
- The summary is written by the main agent using the full conversation context (no separate LLM request): a handoff document is saved to the system temp directory and also becomes the summary of the squashed conversation. If the agent fails to hand in a summary, the squash is cancelled automatically and can be retried.

Call `session_log` first and use the index of a finished turn as `from`. The agent keeps working automatically after the squash.

## Install

```bash
pi install npm:pi-session-tools
```

## Context threshold nudges

When the conversation crosses a threshold (default 150k / 200k / 250k / 300k tokens), the agent is nudged to consider squashing. Configure it:

```jsonc
// ~/.pi/agent/extensions/pi-session-tools/config.json
{ "squashContextThresholds": [150000, 200000, "75%"] }   // numbers and percentages can be mixed
```

The environment variable `PI_SESSION_TOOLS_SQUASH_THRESHOLDS` (comma separated, e.g. `150000,75%`) is also supported.

## Localization

All user-facing text is provided in `zh-CN` and `en-US` through `pi-extensions-i18n`.
