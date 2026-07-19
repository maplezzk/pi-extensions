# pi-tool-supervisor

`pi-tool-supervisor` is a post-edit review extension for Pi. It checks the actual file change produced by `edit` or `write` against project rules and returns a structured review audit to the agent.

## What it solves

An edit tool can complete successfully while the resulting file still violates local conventions, architecture constraints, security rules, or task-specific instructions. Reviewing the actual before/after diff gives a model-based reviewer the information needed to catch those issues immediately, while keeping the review policy configurable per project.

## How it works

- Captures the file state before `edit` / `write` and the actual file state after the tool result.
- Builds a diff and selects only reviewers whose rule files match the changed file.
- Supports multiple reviewers running in parallel, each with its own model and one or more rule files.
- Reads optional front matter from rule files for `enabled`, `filePatterns`, `complexity`, and `consumers`.
- Returns `passed`, `rejected`, `failed`, or `skipped` status with summaries, findings, rule groups, and durations.
- Re-reads the configuration for every edit/write, so configuration changes apply to the next operation.
- Shows an audit card through Pi's display middleware or a fallback renderer.

It observes Pi's native events and does not register a replacement `edit` or `write` tool.

## Install

```bash
pi install npm:pi-tool-supervisor
```

Reload Pi after installation:

```text
/reload
```

Use the interactive configuration command:

```text
/pi-tool-supervisor
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
      ]
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
| `reviewers` | Reviewer name, model, rule files, and optional matching behavior. |

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

## Review semantics

- A rejected review is appended to the tool result with findings; the agent is expected to address it before continuing.
- A reviewer failure is reported as an incomplete review and the original edit result is allowed through.
- A failed tool call or an unchanged file is skipped.
- The extension does not roll back edits, block the operating system, or replace Pi's permission and sandbox controls.

When upgrading from `pi-file-edit-review`, the extension reads the legacy configuration if the new configuration does not exist. Saving through `/pi-tool-supervisor` writes the new configuration path.

## Requirements

- Node.js 22 or newer.
- A configured Pi model for each enabled reviewer.
- Rule files that describe the project-specific checks the reviewer should apply.

## License

[MIT](../../LICENSE)
