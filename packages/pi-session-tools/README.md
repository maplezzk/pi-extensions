# pi-session-tools

Session tooling for the [Pi coding agent](https://github.com/earendil-works/pi): a bash pipe output cache and conversation squashing.

[中文文档](./README.zh-CN.md)

## Features

- When a bash pipeline filters output through `grep`, `tail`, or `head`, the full pre-filter output is written to the system temp directory under `pi-pipe-cache/` and the path is appended to the tool result, so you can re-filter the cached file instead of re-running the command.
- Provides `session_log`: lists user messages and valid starting points on the active branch using their original indices. A retained user anchor previously used for squashing remains reusable, so automatic continuation added after the last snapshot can be folded into the next one; original branches remain recoverable through `/tree`.
- Provides `session_squash`: accepts the summary and continuation mode, then squashes the conversation from a chosen message to free up context. Nothing is deleted; use `/tree` to go back.
- The main agent generates the summary from the full conversation context and submits it directly in the `session_squash` call (no separate LLM request or finalize step); modified file paths in the squashed range are appended automatically, while read-only paths are not copied wholesale into the snapshot.

Call `session_log` first, use the index of a completed turn as `from`, and pass a complete task-state snapshot to `session_squash`. The summary accepts any non-empty format and is not rejected for missing a title, sections, or `User`/`Agent` timeline; for easier handoff, you may organize it with `# Handoff: <topic>`, `Timeline of user and agent work`, `Current focus`, `Errors and resolutions`, `Code and artifact state`, `Environment and repository state`, `Completed work and decisions`, `Active issues and next actions`, `Important context and boundaries`, and `Suggested skills`. If the title or timeline is omitted, the extension adds a title or compact factual timeline automatically. The selected user turn remains as the new branch anchor so later user-turn indices stay stable; the snapshot replaces the completed suffix as the authoritative task state and is presented to the next model context as Pi's native compaction summary, explicitly telling the receiving agent to continue from the snapshot. That retained anchor remains selectable on later `session_log` calls, allowing a new snapshot to absorb automatic continuation between the previous snapshot and the next user turn. A later squash may also start from an earlier index to replace a broader range.

Squash at a safe task or phase checkpoint, such as after a phase or verification completes, a key decision is settled, or before entering the next phase; the whole task need not be delivered. The snapshot should focus on what was done in the squashed range, its target, final outcomes, and verification, then state the exact stopping point, remaining work, artifact state, and next action. Completed work must not be repeated under remaining work. Use `VERIFIED`, `INFERRED`, `UNKNOWN`, `NOT VERIFIED`, or `BLOCKED` when needed. Preserve effective task state rather than maintenance mechanics such as context thresholds, `session_log`, `session_squash`, or session switching. Explicitly select the continuation mode on every squash: use `continuation: "auto"` when work can resume immediately; when the current task is complete and the next action requires new user input, use `continuation: "next-user"` to save the snapshot without triggering another model turn. If the snapshot conflicts with workspace, Git, or test evidence, the evidence wins and the conflict must be reported.

## Install

```bash
pi install npm:pi-session-tools
```

## Context threshold nudges

When the conversation crosses a threshold (default 150k / 200k / 250k / 300k tokens), the nudge shows the agent `used tokens / context window (percentage)` and asks it to squash at the nearest safe task or phase checkpoint without waiting for the whole task to finish. The nudge is advisory and runs only after the model stops normally; user aborts and provider errors do not trigger it. Configure it:

```jsonc
// ~/.pi/agent/extensions/pi-session-tools/config.json
{ "squashContextThresholds": ["150k", "200k", "75%"] }   // k, numbers and percentages can be mixed
```

Or use the interactive command `/config:session-tools` (alias `/pi-session-tools`).

The environment variable `PI_SESSION_TOOLS_SQUASH_THRESHOLDS` (comma separated, e.g. `150k,75%`) is also supported.

## Forced squash

Forced squash is disabled by default. Enable it with a JSON number from `0` to `1`, representing the fraction of the model context window:

```jsonc
{
  "squashContextThresholds": ["150k", "200k", "75%"],
  "forceSquashContextThreshold": 0.9 // 90% of the context window; null disables it
}
```

Or run `/config:session-tools force 0.9`; use `/config:session-tools force off` to disable it. Percentage strings such as `"90%"` are not accepted for forced squash.

After each completed assistant tool batch, the extension checks context usage. At the forced threshold it aborts the current agent loop before another model turn, saves the active tool set, and permits only `session_log` and `session_squash`. Other tool calls are blocked. If the agent stops without squashing, another forced turn starts automatically. The restriction remains until `session_squash` succeeds, then the previous tools are restored and work continues from the summary. Already-running tools are allowed to finish so file mutations are not interrupted halfway.

## Localization

All user-facing text is provided in `zh-CN` and `en-US` through `pi-extensions-i18n`.
