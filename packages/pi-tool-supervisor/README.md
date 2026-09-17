# pi-tool-supervisor

`pi-tool-supervisor` is a configurable tool-lifecycle review extension for Pi. It can review selected tools before or after execution and uses the actual file change for `edit` and `write` audits.

## What it solves

An edit tool can complete successfully while the resulting file still violates local conventions, architecture constraints, security rules, or task-specific instructions. Reviewing the actual before/after diff gives a model-based reviewer the information needed to catch those issues immediately, while keeping the review policy configurable per project.

## How it works

- Each reviewer selects `tools`, a `trigger`, and optionally a local `condition` module: omitted fields default to `edit`/`write` + `after`, and `"*"` matches every built-in or custom tool.
- Before reviewers inspect the proposed input and an explicit rejection blocks the native Pi tool call; model failures remain fail-open without injecting errors into the Agent's tool result, while the audit card keeps the failed status. Condition module failures block the before call.
- Captures the file state before `edit` / `write` and the actual file state after the tool result.
- Sends the real-line-numbered post-edit file with the diff; files above `maxFileContextChars` use bounded excerpts around the first and last changed lines.
- Supports multiple reviewers running in parallel, each with its own model and one or more rule files.
- Reads optional front matter from rule files for `enabled`, `filePatterns`, `complexity`, and `consumers`.
- Returns `passed`, `rejected`, `failed`, or `skipped` status with summaries, findings, rule groups, and durations.
- Treats a reviewer verdict as binding only when it is self-consistent: `passed: false` without any actionable (`error`-severity) finding is downgraded to passed and annotated, so a self-contradicting reviewer cannot block an edit with nothing to fix.
- Passes native tool results through unchanged; it does not truncate or write tool output to temporary files. Output control belongs to Pi or other extensions.
- Re-reads the configuration for every tool call, so configuration changes apply to the next matching operation.
- Shows an audit card through Pi's display middleware or a fallback renderer. The shared display protocol is provided by `pi-extensions-tool-display`.

It observes Pi's native events and does not register a replacement `edit` or `write` tool.

## Review engines

Each reviewer picks an engine with `backend`. Omitting it keeps the original behavior.

| `backend` | Who judges | Cost and latency | Result shape |
| --- | --- | --- | --- |
| `model` (default) | A Pi chat model reads every rule and the diff in one prompt | One chat completion per reviewer | Free-form JSON: `passed`, `summary`, `findings` |
| `typesafe` | TypeSafe System One answers one typed question per rule in a single batched request | Measured on a 3-rule reviewer: ~1-2 s, ~1,400 input tokens, about US$0.00006 per review | A calibrated `noul` probability per rule; code applies the thresholds |

### TypeSafe backend

The `typesafe` backend turns each rule file into one Noul question - "does code added or changed in `diff` violate this rule?" - answered as a probability. Every rule of one reviewer is asked in a single request, because TypeSafe answers all questions over the same state in parallel. Code owns everything else: `threshold` decides whether a rule counts as hit, `severity` decides whether a hit blocks, and a second, smaller Choice request locates the offending line among the lines the diff actually added.

Because TypeSafe returns judgments and not prose, the fixing advice comes from the rule file's `## Fix` section, written once by the rule author. It is not generated per review.

```json
{
  "name": "code-taste",
  "backend": "typesafe",
  "typesafeModel": "jev-latest",
  "rulesFiles": ["/absolute/path/to/no-swallowed-error.md"],
  "tools": ["edit", "write"],
  "trigger": "after"
}
```

Set `TYPESAFE_API_KEY` in the environment; `TYPESAFE_ENDPOINT` overrides the endpoint. A missing key, a failed request, or a rule that cannot be judged produces a visible `failed` audit entry and does not block the tool, which matches how a failed chat-model review behaves.

A rule file for this backend needs a criteria section and should carry a fix hint:

```markdown
---
name: no-swallowed-error
severity: error
threshold: 0.85
---
# Do not swallow failures

## Criteria
true: An added line catches an error and continues silently: empty catch, an ignored rejected promise, or a default/null/empty value that hides the failure
false: The failure is surfaced by rethrowing, propagating, or logging; or the change adds no error handling

## Fix
Propagate the failure to the caller, or at least log it and return an explicit error value. Do not hide it behind a default.
```

`## Criteria` (`## 判据` works too) accepts `true:` and `false:` lines; an indented line continues the previous definition. `## Fix` (`## 修复提示`) becomes the finding text. A rule file without a criteria section cannot be judged: it is reported as a failed review with its file path, never silently skipped.

Rule front matter additions for this backend:

| Field | Meaning |
| --- | --- |
| `severity` | `error`, `warning`, or `info`. Only `error` blocks. Default `error`. |
| `threshold` | Probability at which the rule counts as hit; greater than 0 and at most 1. Default `0.85`. Calibrate it per rule. |

Limitations worth knowing before treating a `typesafe` reviewer as a gate:

- Line localization needs the post-edit file. A `before` review only has it for `write`, so `edit` before-reviews report rule-level issues without a line number.
- When the diff adds more than 40 lines, localization is skipped and reported as a warning; the rule-level issues are still reported.
- The whole post-edit file is sent as context, bounded by `maxFileContextChars`. It roughly doubles the input tokens compared with a diff-only request.
- A probability is a calibrated judgment, not a guarantee. Validate thresholds against your own rules, and expect borderline rules to drift.

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
  "maxFileContextChars": 50000,
  "maxRuleLines": 100,
  "reviewers": [
    {
      "name": "project-rules",
      "model": "provider/model",
      "rulesFiles": [
        "/absolute/path/to/rules.md"
      ],
      "tools": ["edit", "write"],
      "trigger": "after",
      "condition": "/absolute/path/to/condition.ts"
    }
  ]
}
```

Each reviewer must have either a `provider/model` reference (`model` backend) or a `typesafeModel` (`typesafe` backend), plus either `rulesFile` or `rulesFiles`. Relative rule-file and condition-module paths are resolved from the current project working directory.

| Setting | Meaning |
| --- | --- |
| `enabled` | Enables or disables the review layer. |
| `timeoutSeconds` | Maximum time allowed for each reviewer model call. |
| `maxFileContextChars` | Maximum post-edit file context sent to reviewers. The default is 50,000 characters; oversized files use bounded, explicitly marked excerpts around changed lines. |
| `maxRuleLines` | Maximum rule-file size accepted for a single review rule. |
| `backend` | `model` (default) or `typesafe`. Selects the review engine. |
| `typesafeModel` | TypeSafe model name used by the `typesafe` backend. Defaults to `jev-latest`. |
| `condition` | Optional local TypeScript/ESM module path. Its default export receives the native Pi tool event, `ExtensionContext`, and `ToolConditionHelpers`; returning `false` skips this reviewer without a model call. |
| `reviewers` | Reviewer name, model, rule files, `tools`, `trigger`, and optional condition module. Missing lifecycle fields keep the legacy `edit`/`write` + `after` behavior. |

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

### Condition modules

A reviewer may set `condition` to a local TypeScript or ESM module path. Relative paths resolve from the current project working directory, and `~` is expanded using the Pi home directory. The module must export a default synchronous or asynchronous function:

```ts
import type {
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ToolConditionHelpers } from "pi-tool-supervisor";

export default function condition(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  helpers: ToolConditionHelpers,
): boolean {
  if (event.toolName !== "bash") return false;
  const command = event.input.command;
  if (typeof command !== "string") return false;

  // The native event and context are available for custom policy.
  const ast = helpers.parseBash(command);
  return ast.errors?.length === 0 && ast.commands.some((statement) =>
    statement.command.type === "Command" && statement.command.name?.value === "mvn",
  );
}
```

The first argument is the original `tool_call` event for `before` reviewers or the original `tool_result` event for `after` reviewers. The second argument is the native `ExtensionContext`, with the same capabilities available to other Pi extensions. A third helper argument provides `parseBash(source)` without requiring the condition module to resolve supervisor internals.

A condition returning `false` skips the reviewer without loading its rules or calling its model. A module load error, execution error, non-boolean result, or timeout is visible; `before` treats it as a failed gate and blocks the tool. Use `trigger: "before"` when a rejected review must prevent execution; `after` remains diagnostic only.

## Review semantics

- A before reviewer rejection blocks the native tool call and sends the complete reason to the Agent; model failures/skips remain fail-open and stay only in the audit details, without appending an error to the tool result. Condition module load or execution failures are treated as a failed gate and block the before call.
- An after rejection is diagnostic only and sends the diagnostic to the Agent without rolling back a completed tool call; an after model failure stays only in the audit details and does not append an error diagnostic. A failed tool skips after review and preserves the original error.
- Review rejections and configuration warnings use Pi's `ctx.ui.notify`; reviewer failures remain in the audit card and are not injected into the Agent's context. The extension does not call `console.warn` or `console.error` directly.
- If the parent Agent request is interrupted, every in-flight reviewer model request is cancelled together; reviewers not yet started are skipped, and parent cancellation is reported as skipped rather than as a provider failure.
- A failed tool call or an unchanged file is skipped.
- The extension does not roll back edits, block the operating system, or replace Pi's permission and sandbox controls.

When upgrading from `pi-file-edit-review`, the extension reads the legacy configuration if the new configuration does not exist. Saving through `/config:tool-supervisor` writes the new configuration path. `/pi-tool-supervisor` remains available as a compatibility alias.

## Requirements

- Node.js 22 or newer.
- A configured Pi model for each enabled `model` reviewer.
- A `TYPESAFE_API_KEY` for each enabled `typesafe` reviewer.
- Rule files that describe the project-specific checks the reviewer should apply.

## License

[MIT](../../LICENSE)
