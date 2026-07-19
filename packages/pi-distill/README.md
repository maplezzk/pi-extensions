# pi-distill

> **Keep the facts. Spend context on decisions.**

`pi-distill` is a Pi extension that controls how tool results enter the agent context. It does not replace tools or change how commands run; it adds an optional result-processing layer after the tool has returned its real output.

## What it solves

Coding agents often need only the important lines from a command, search, or file read. Passing every byte of a large result into the next turn increases context usage and can hide the signal in logs or generated files. `pi-distill` adds a result-level distillation layer without replacing Pi's built-in tools.

## Context savings in practice

Build logs, diff output, and test reports often contain repeated status lines, unchanged context, stack-trace noise, and details that are not needed for the next decision. Those are strong candidates for high compression. In one real Pi session, the result below went from 51,215 characters to 240 characters: **213.40× compression and 99.5% fewer output characters**.

![pi-distill context savings example](./assets/context-savings-example.png)

The screenshot reports character reduction, not an exact tokenizer measurement. In practice this usually removes a similar order of magnitude of context tokens, but the exact token saving depends on the language, content, and model tokenizer. Treat 90%+ as an observed outcome for suitable verbose outputs, not a guarantee for every command; use `RAW` whenever the complete output is needed.

| Scenario | Typical noise | What the distill result keeps |
| --- | --- | --- |
| Build / compile | Repeated progress, warnings, and unchanged setup lines | Pass/fail, first actionable errors, affected files, and next steps |
| Diff inspection | Large unchanged hunks and formatting noise | Changed files, relevant hunks, and review-relevant facts |
| Tests | Per-test verbosity, snapshots, and framework boilerplate | Totals, failed cases, key assertions, and useful diagnostics |

## Prompt language

The distillation prompt strictly follows the current locale selected by `/pi-language`. Changing the persisted locale is picked up on the next tool call, including when the language command and `pi-distill` are loaded from separate package instances. `PI_EXTENSIONS_LOCALE` remains the explicit environment-variable override. The original user message is included only as language context and never overrides the selected locale.

## How it works

- Observes `bash`, `read`, `grep`, and `find` through Pi's native `tool_call` / `tool_result` events.
- Uses the tool's `outputPrompt` as the source of truth for whether and how to distill a result.
- Treats a prompt containing only `RAW` as an explicit request for the original output.
- Uses the current session model by default, or a configured `provider/model` override.
- Keeps diagnostic metadata such as status, character counts, compression ratio, duration, and anomalies in the tool result details.
- Writes oversized distilled output or final output to a temporary file and returns its path instead of overflowing the tool result.
- Adds a compact audit card when the active Pi display middleware is available, with a fallback renderer otherwise. The shared display protocol is provided by `pi-extensions-tool-display`.

It does not register a second `bash`, `read`, `grep`, or `find` tool.

## Install

```bash
pi install npm:pi-distill
```

Reload Pi after installation:

```text
/reload
```

Open the interactive configuration command with:

```text
/pi-distill
```

## The idea

We are not trying to make the agent see less information. We are trying to avoid making it carry thousands of log lines into context just to find one conclusion.

The execution layer should preserve facts. The consumption layer should control context cost. `pi-distill` connects the two:

- the tool executes and returns facts;
- the agent states what it cares about through `outputPrompt`;
- the extension reads the actual result before deciding whether to call a distillation model;
- the model compresses the consumption path without changing the tool's semantics;
- diagnostics show whether the transformation actually saved context.

Distillation is therefore a tool contract, not a blanket “summarize everything” switch: ask for the information you need, or explicitly keep the original when you need completeness.

## Why it exists

Builds, tests, and diffs often contain repeated status lines, unchanged context, framework boilerplate, and stack-trace noise. The agent may need only the failure, changed files, or final state, but still has to consume the entire result first.

Always truncating can hide the important fact. Adding a separate summary tool creates another decision and another call. Waiting until the agent has read the output is too late. `pi-distill` processes the result before the next reasoning step, while retaining an explicit raw-output mode and safe fallbacks.

## Observed context savings

In the real Pi session shown below, an output went from **51,215 characters** to **240 characters**: **213.40× compression** and **99.5% fewer output characters**.

![pi-distill context savings example](./assets/context-savings-example.png)

The screenshot measures character reduction, not an exact tokenizer count. Actual token savings depend on the language, content, and model tokenizer. For suitable verbose build logs, diffs, and test output, savings of 90% or more have been observed, but this is not a guarantee for every command.

| Scenario | Typical noise | What the distilled result prioritizes |
| --- | --- | --- |
| Build / compile | Repeated progress, setup lines, repeated warnings | Pass/fail, first actionable error, affected files, next steps |
| Diff inspection | Large unchanged hunks and formatting noise | Changed files, relevant hunks, review-relevant facts |
| Tests | Per-test verbosity, snapshots, framework boilerplate | Totals, failed cases, key assertions, useful diagnostics |

Savings are not the only metric. The extension records duration, original and result character counts, compression ratio, and anomalies. If a summary does not create real value, it reports `ineffective-compression` instead of silently claiming success.

## How it works

```text
Agent states a handling goal
        ↓ through outputPrompt
Tool runs the real operation and returns stdout / stderr / files / media
        ↓
pi-distill uses the actual result and configuration to keep it, distill it, or write it to a file
        ↓
Agent consumes a result suited to the current decision, with auditable diagnostics
```

1. At session start, the extension adds `outputPrompt` to every active tool whose parameter schema is an object. It does not hard-code `bash`, `read`, `grep`, or `find`.
2. The `tool_call` handler captures the parameter and removes it before forwarding the call, so the underlying tool never receives the extension-only field.
3. The `tool_result` handler sees the actual output and decides what to do; it does not rely on the agent predicting the output size.
4. No prompt skips the model. A prompt containing only `RAW` explicitly requests the original. Any other non-empty prompt permits distillation once the configured threshold is reached.
5. If distillation fails, no model is available, or compression is ineffective, the original facts are retained and the status is exposed through details and the audit card.

## Output contract

| `outputPrompt` | Behavior | Use it when |
| --- | --- | --- |
| Omitted | Skip the distillation model and keep the original text; oversized text may still be written to a temporary file by the final size guard | The output is short or the tool should decide |
| Exactly `RAW` (case-insensitive) | Skip the distillation model and keep the complete original text; oversized text is returned through a file path | You need to inspect, copy, or verify exact output |
| Any non-empty value other than `RAW` | Call the model once the output reaches the threshold; the prompt defines what to retain | “Keep errors, warnings, and final status” workflows |
| Any non-text content such as images or audio | Preserve the result as-is; do not send it to the distillation model or apply text truncation | Image reads, binary results, and mixed text/media results |

`RAW` is the only explicit completeness signal. Natural-language phrases such as “完整输出” or “all matches” can be ambiguous and are not treated as control commands.

## Prompt language

The distillation prompt strictly follows the locale selected by `/pi-language`:

- the next tool call reads the newly persisted locale after a language switch;
- separate package instances still synchronize through the shared locale setting;
- `PI_EXTENSIONS_LOCALE` remains an explicit environment-variable override;
- the original user message is passed as task context only and cannot accidentally force the prompt language.

## Scope and boundaries

- Handles every active tool with an object parameter schema; whether `outputPrompt` can be injected is determined by the tool schema, not a fixed allowlist.
- Registers no replacement tools, does not change tool execution semantics, and does not depend on the unrelated npm package `pi-tool-display`.
- Text distillation is lossy; use `RAW` when completeness matters.
- Non-text results are a completeness boundary: images, audio, binary data, and mixed content bypass text distillation.
- Oversized distilled or final text is written to a temporary file and represented by its path, preventing unbounded context growth.
- If no model is available, distillation fails open: the original result is retained and Pi can continue running.

## Configuration

Default configuration path:

```text
~/.pi/agent/extensions/pi-distill/config.json
```

Start from [`config.example.json`](./config.example.json):

```json
{
  "enabled": true,
  "model": "",
  "minChars": 200,
  "maxChars": 100000,
  "maxOutputChars": 10000,
  "timeoutSeconds": 10,
  "missedCompressionRatio": 10,
  "summarizeErrors": true,
  "render": {
    "enabled": true,
    "showPrompt": true,
    "showResult": true
  }
}
```

Configuration-file fields take precedence over environment variables. Unspecified fields fall back to `PI_DISTILL_*`, then the legacy `PI_BASH_SUMMARY_*` variables, then defaults.

| Setting | Meaning |
| --- | --- |
| `model` | Optional `provider/model`; empty uses the current Pi session model. |
| `minChars` | Minimum output size before a summary is requested. |
| `maxChars` | Maximum size of the model's distilled result before it is written to a file. |
| `maxOutputChars` | Maximum text size returned to the agent; larger results are written to a file. |
| `timeoutSeconds` | Maximum time allowed for the distillation model call. |
| `missedCompressionRatio` | Long-output threshold for a diagnostic when no summary prompt was supplied. |
| `summarizeErrors` | Whether error results should still be sent to the distillation model. |
| `render.*` | Controls the audit card, prompt preview, and result preview. |

The main environment variables are `PI_DISTILL_MODEL`, `PI_DISTILL_MIN_CHARS`, `PI_DISTILL_MAX_CHARS`, `PI_DISTILL_MAX_OUTPUT_CHARS`, `PI_DISTILL_TIMEOUT_SECONDS`, `PI_DISTILL_MISSED_COMPRESSION_RATIO`, and `PI_DISTILL_SUMMARIZE_ERRORS`.

## Requirements

- Node.js 22 or newer.
- A current Pi session model, unless `model` points to an available configured model.

## License

[MIT](../../LICENSE)
