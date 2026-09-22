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
- Treats a reviewer verdict as binding only when it is self-consistent: `passed: false` without any finding is downgraded to passed and annotated, so a self-contradicting reviewer cannot block an edit with nothing to fix.
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

The `typesafe` backend turns every numbered clause of a rule file into one Noul question - "does code added or changed in `diff` violate this clause?" - answered as a probability. Every clause of one reviewer is asked in a single request, because TypeSafe answers all questions over the same state in parallel. Code owns the rest: `threshold` decides whether a clause counts as hit, and a second, smaller Choice request locates the offending line among the lines the diff actually added.

**Rule files are engine-independent: switching backends changes one config line and not a single character of a rule file.** There is no `## Criteria` section to write, no severity level to declare, and no block heading to add.

The API key is read from `typesafe.apiKey` in `config.json` first and falls back to the `TYPESAFE_API_KEY` environment variable; `typesafe.endpoint` falls back to `TYPESAFE_ENDPOINT` and then to the official endpoint. A missing key, a failed request, or a rule file with no clause to judge produces a visible `failed` audit entry and does not block the tool, which matches how a failed chat-model review behaves.

#### Enabling it

1. Make sure the installed version carries this backend (`pi update --extensions`).
2. Add the TypeSafe connection settings at the top level of `config.json` (`endpoint` is optional and defaults to the official endpoint):

```json
"typesafe": {
  "apiKey": "<your-typesafe-api-key>"
}
```

3. Switch the reviewer you want to the `typesafe` engine (drop the `model` field):

```json
{
  "name": "code-taste",
  "backend": "typesafe",
  "typesafeModel": "jev-latest",
  "rulesFiles": ["/absolute/path/to/javascript-typescript.md"],
  "tools": ["edit", "write"],
  "trigger": "after"
}
```

No rule file changes are needed. Restart the Pi session (or `/reload`) to apply it; start with one rule file for a few days and watch for false positives and misses before switching the rest.

#### How it reads your rule file

```markdown
---
name: javascript-typescript
filePatterns: ["**/*.ts"]
---
# JavaScript / TypeScript rules

## Ownership (takes precedence)

1. `ruleGroup` may only use clause names or numbers that appear in this file.  ← reporting, not judged
2. Do not report rules this file does not contain.                             ← reporting, not judged

## Requirements

1. **No magic values**: non-obvious numbers in business logic must be extracted into a semantic `const` or shared configuration.
2. **At most 3 parameters**: a declaration with 4 or more parameters must use a parameter object.
3. **No `any`**: prefer concrete types; use `unknown` and narrow it at the boundary.
   Do not bypass type checking with `as any` or `any[]`.
```

This becomes **3 independent rules**:

| Judgment id | Rule name (the `ruleGroup` in each finding) | Criterion | `noul` | Outcome |
| --- | --- | --- | --- | --- |
| `rule_1` | `Requirements 1 No magic values` | clause text | 0.52 | below threshold |
| `rule_2` | `Requirements 2 At most 3 parameters` | clause text | 0.03 | below threshold |
| `rule_3` | `Requirements 3 No any` | clause text | **0.97** | blocks, located at line 3 |

A clause's text is **both the criterion and the finding text**. The three clauses are three independent Noul questions **answered in the same request**.

#### Splitting rules

| What you write | How it is treated |
| --- | --- |
| A `1. text` numbered clause | One rule; indented continuation lines join the same clause |
| Numbered items inside a section whose heading starts with `归属` ("Ownership") | **Not judged** - those are reporting requirements, not code rules |
| A legacy `[error]` / `[warning]` left on a clause | Stripped from the criterion; there are no levels, so **every hit blocks** (old rule files keep working) |
| A `**bold**` phrase in a clause | Used as the rule name, combined as `{section} {number} {title}` - this is the `ruleGroup` |
| `threshold` in front matter | Hit threshold for every clause in that file; default `0.85` |
| Several rule files on one reviewer | Judgment ids gain a file prefix (`f1_rule_1`); the same number in different files is normal and never warns, only a duplicate number inside one file does |
| Other prose, `## Output` style sections | Does not affect judging |
| A numbered list of **exemptions** ("only reads", "only runs a script") | Still one rule per item, but asked backwards - see below |

A section heading that starts with `归属` (English rule files often use `## Ownership and severity`) is always skipped when judging, so requirements like "`ruleGroup` may only use clause names that appear in this file" never turn into code rules.

A numbered clause must say **what code counts as a violation**. A numbered list of exemptions does not disappear: every item becomes a rule and is asked as "does this code violate *only reads*?", which inverts its meaning, while the real prohibition - written as bullets or prose - is never asked at all. **Extracting clauses is not the same as extracting the right clauses**, so the `no clause is an error` check below cannot catch it: the file does yield clauses, just the wrong kind. Write clauses as prohibitions and put the exemptions inside the clause they exempt.

#### You can see which rule failed

Every hit clause produces its own finding, named the way your file names it:

```
Found 2 must-fix problems
- [Requirements 1 No magic values] line 5: non-obvious numbers in business logic must be extracted…
  Offending line: const fallback = 30000;
- [Requirements 4 No any] line 3: prefer concrete types; use `unknown`…
  Offending line: const raw = (config as any).timeout;
```

The reviewer `summary` also lists every `noul`, as in `2 rules hit: Requirements 1 No magic values=0.92, Requirements 4 No any=0.97`.

One request asks N clauses, so adding clauses barely adds latency: measured 6 clauses at 2,438 input tokens, and 10 rules batched into one request at 1.1 s / 1,351 input tokens, against 4.3 s / 7,525 input tokens for 10 separate requests.

#### No clauses is an error, not a pass

When a rule file yields no numbered clause at all (say it is all prose, or the items are bullets), the review reports `failed` with the file path and is **never treated as passing**. Otherwise enabling typesafe would silently disable a rule file.

#### Limitations

Limitations worth knowing before treating a `typesafe` reviewer as a gate:

- **The more specific the clause, the better the judgment.** When a probability is off, fix how the sentence is written (spell out the exemptions) rather than changing the format. Measured: "non-obvious numbers must be extracted into a semantic constant" is too subjective about "semantic", so `const fallback = 30000;` scored 0.52, while the sharp-edged "no `any`" scored 0.97.
- **The threshold is per file.** Clause quality varies within one file, and there is no per-clause override; sharpen the clause instead.
- **No severity levels anywhere.** Both backends block on any hit; a legacy `[error]` / `[warning]` marker in a rule file is stripped from the criterion and never changes the outcome.
- Line localization needs the post-edit file. A `before` review only has it for `write`, so `edit` before-reviews report rule-level issues without a line number.
- When the diff adds more than 40 lines, localization is skipped and reported as a warning; the rule-level issues are still reported.
- The whole post-edit file is sent as context, bounded by `maxFileContextChars`. It roughly doubles the input tokens compared with a diff-only request.
- Every clause body is sent, so detailed clauses raise input tokens (measured about 2.4k input tokens for 6 clauses).
- A probability is a calibrated judgment, not a guarantee.

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

It opens a settings panel: the top level holds the master switch, timeout, file-context and rule-line limits, and the TypeSafe connection, then one row per reviewer. Selecting a reviewer opens its fields (enable, name, review engine, review model, rule files, tools, trigger, condition module, file patterns) and a delete action. The review-model row opens a searchable list of the models available in this session. Every change is written to the configuration file immediately, so no `/reload` is required.

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
  "typesafe": {
    "apiKey": "<your-typesafe-api-key>",
    "endpoint": "https://api.typesafe.ai/v1/systemone"
  },
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
    },
    {
      "name": "code-taste",
      "backend": "typesafe",
      "typesafeModel": "jev-latest",
      "rulesFiles": [
        "/absolute/path/to/javascript-typescript.md"
      ],
      "tools": ["edit", "write"],
      "trigger": "after"
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
| `typesafe` | Connection settings for the `typesafe` backend: `apiKey` and `endpoint`, both optional and both falling back to the matching environment variable. |
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

`threshold` is an optional front matter field used only by the `typesafe` backend, defaulting to `0.85`; the `model` backend ignores it.

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
- A TypeSafe API key for each enabled `typesafe` reviewer: `typesafe.apiKey` in `config.json`, or the `TYPESAFE_API_KEY` environment variable.
- Rule files that describe the project-specific checks the reviewer should apply.

## License

[MIT](../../LICENSE)
