# pi-tool-supervisor

`pi-tool-supervisor` is a configurable tool-lifecycle review extension for Pi. It can review selected tools before or after execution and uses the actual file change for `edit` and `write` audits.

## What it solves

An edit tool can complete successfully while the resulting file still violates local conventions, architecture constraints, security rules, or task-specific instructions. Reviewing the actual before/after diff gives a model-based reviewer the information needed to catch those issues immediately, while keeping the review policy configurable per project.

## How it works

- Each reviewer selects `tools` and a `trigger`: omitted fields default to `edit`/`write` and `after`; `"*"` matches every built-in or custom tool.
- Before reviewers inspect the proposed input and an explicit rejection blocks the native Pi tool call; reviewer failures remain fail-open and visible.
- Captures the file state before `edit` / `write` and the actual file state after the tool result.
- Supports multiple reviewers running in parallel, each with its own model and one or more rule files.
- Reads optional front matter from rule files for `enabled`, `filePatterns`, `complexity`, and `consumers`.
- Returns `passed`, `rejected`, `failed`, or `skipped` status with summaries, findings, rule groups, and durations.
- Re-reads the configuration for every tool call, so configuration changes apply to the next matching operation.
- Shows an audit card through Pi's display middleware or a fallback renderer. The shared display protocol is provided by `pi-extensions-tool-display`.

It observes Pi's native events and does not register a replacement `edit` or `write` tool.

## Install

```bash
pi install npm:pi-tool-supervisor
```

The package manifest also loads the shared `pi-extensions-tool-display` dependency as one extension entry; no separate host package is required.

Reload Pi after installation:

```text
/reload
```

Use the interactive configuration command:

```text
/config:tool-supervisor
```

## Configuration

The default configuration path is:

```text
~/.pi/agent/extensions/pi-tool-supervisor/config.json
```

Start from [`config.example.json`](./config.example.json):

```json
{
  "enabled": true,
  "timeoutSeconds": 10,
  "maxOutputChars": 10000,
  "maxRuleLines": 100,
  "reviewers": [
    {
      "name": "project-rules",
      "model": "provider/model",
      "rulesFiles": [
        "/absolute/path/to/rules.md"
      ],
      "tools": ["edit", "write"],
      "trigger": "after"
    }
  ]
}
```

Each reviewer must have a `provider/model` reference and either `rulesFile` or `rulesFiles`. Relative rule-file paths are resolved from the current project working directory.

| Setting | Meaning |
| --- | --- |
| `enabled` | Enables or disables the review layer. |
| `timeoutSeconds` | Maximum time allowed for each reviewer model call. |
| `maxOutputChars` | Maximum size of the returned tool result; larger output is written to a temporary file. |
| `maxRuleLines` | Maximum rule-file size accepted for a single review rule. |
| `reviewers` | Reviewer name, model, rule files, `tools`, and `trigger`. Missing lifecycle fields keep the legacy `edit`/`write` + `after` behavior. |

Rule-file front matter can scope a rule to particular files or consumers:

```yaml
---
name: TypeScript safety
enabled: true
filePatterns:
  - "**/*.ts"
complexity: local
consumers:
  - editor-review
---
```

`filePatterns` uses a simplified glob syntax: `*` does not cross `/`, `**` does, and `**/` at any position matches zero or more directory levels. Backslashes are normalized to `/`, and a leading `./` is ignored.

## Review semantics

- A before reviewer rejection blocks the native tool call and emits a standalone audit with the complete reason; before failures/skips are fail-open but remain visible on the next tool result.
- An after rejection is diagnostic only and never rolls back a completed tool call; a failed tool skips after review and preserves the original error.
- If the parent agent request is already aborted, the review is skipped before any reviewer model request is started.
- A failed tool call or an unchanged file is skipped.
- The extension does not roll back edits, block the operating system, or replace Pi's permission and sandbox controls.

When upgrading from `pi-file-edit-review`, the extension reads the legacy configuration if the new configuration does not exist. Saving through `/config:tool-supervisor` writes the new configuration path. `/pi-tool-supervisor` remains available as a compatibility alias.

## Requirements

- Node.js 22 or newer.
- A configured Pi model for each enabled reviewer.
- Rule files that describe the project-specific checks the reviewer should apply.

## License

[MIT](../../LICENSE)
