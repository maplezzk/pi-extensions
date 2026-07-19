# pi-distill

`pi-distill` is a Pi extension for controlling the amount of tool output that reaches the agent context.

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
- Adds a compact audit card when the active Pi display middleware is available, with a fallback renderer otherwise.

It does not register a second `bash`, `read`, `grep`, or `find` tool, and it does not depend on `pi-tool-display`.

## Install

```bash
pi install npm:pi-distill
```

Reload Pi after installation:

```text
/reload
```

Use the interactive configuration command at any time:

```text
/pi-distill
```

## Configuration

The default configuration path is:

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
| `maxOutputChars` | Maximum size returned to the agent; larger results are written to a file. |
| `timeoutSeconds` | Maximum time allowed for the distillation model call. |
| `missedCompressionRatio` | Long-output threshold used for a diagnostic when no summary prompt was supplied. |
| `summarizeErrors` | Whether error results should still be sent to the distillation model. |
| `render.*` | Controls the audit card, prompt preview, and result preview. |

The main environment variables are `PI_DISTILL_MODEL`, `PI_DISTILL_MIN_CHARS`, `PI_DISTILL_MAX_CHARS`, `PI_DISTILL_MAX_OUTPUT_CHARS`, `PI_DISTILL_TIMEOUT_SECONDS`, `PI_DISTILL_MISSED_COMPRESSION_RATIO`, and `PI_DISTILL_SUMMARIZE_ERRORS`.

## Important behavior

Distillation is not lossless. When exact output is required, make the tool request `RAW`; the extension preserves the original result and does not ask the model to summarize it. When a summary is requested but no usable model is available, the original result is retained and the failure is exposed through diagnostics rather than preventing Pi from starting.

## Requirements

- Node.js 22 or newer.
- A current Pi session model, unless `model` points to an available configured model.

## License

[MIT](../../LICENSE)
