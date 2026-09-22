# pi-gen-ui

`pi-gen-ui` renders [json-render](https://json-render.dev) JSON specs as native Pi terminal panels. The model describes a UI as a flat spec, and the extension draws it in the transcript with real terminal widgets: tables, bar charts, sparklines, callouts, timelines, and keyboard-driven inputs.

Two tools:

| Tool | What it does |
| --- | --- |
| `render_ui` | Renders a spec you author. Full control over the element tree. |
| `compose_ui` | Hands layout selection to TypeSafe's decision model (Jev) over candidate elements you supply. Requires an API key; see [Composition](#composition-optional). |

## What it changes

Without this package a model can only describe a dashboard in prose or a markdown table. With it, the same answer arrives as a laid-out panel:

```
╭──────────────────────────────────────────────────────────╮
│ Deployments                                              │
│ ─────────────── services ───────────────                 │
│  LIVE  Region: eu-west-1          ✔ all healthy          │
│ ╭──────────────────────────────────────────────────────╮ │
│ │Service     │ CPU │ Status                            │ │
│ │────────────┼─────┼───────────────────────────────────│ │
│ │api-server  │ 12% │ running                           │ │
│ │worker      │ 64% │ degraded                          │ │
│ ╰──────────────────────────────────────────────────────╯ │
│ TypeScript ████████████████████████ (76%)                │
│ CPU ▃▆▃█▄▇▂▆▅                                             │
│ │ Note                                                   │
│ │ worker latency is above the threshold for 5 minutes    │
╰──────────────────────────────────────────────────────────╯
```

Panels render inline in the tool row, so they scroll with the transcript and can be expanded with Pi's normal tool-row expansion. When a spec contains interactive components, the tool also opens a centred overlay so the user can actually type, pick, and confirm; the resulting state is returned to the model.

## Components

27 components, matching [`@json-render/ink`](https://github.com/vercel-labs/json-render/tree/main/packages/ink)'s standard catalog by name and prop vocabulary, so a spec written for Ink validates here too.

| Group | Components |
| --- | --- |
| Layout | `Box` (row/column, gap, padding, borders, background), `Text`, `Newline`, `Spacer` |
| Content | `Heading`, `Divider`, `Badge`, `Card`, `KeyValue`, `Link`, `StatusLine`, `List`, `ListItem`, `Markdown`, `Callout`, `Metric`, `Timeline` |
| Data | `Table`, `ProgressBar`, `Sparkline`, `BarChart`, `Spinner` |
| Interactive | `TextInput`, `Select`, `MultiSelect`, `ConfirmInput`, `Tabs` |

### Where this renderer differs from Ink

The renderer is honest about its limits instead of quietly dropping things:

- **Ignored props are reported.** The catalog keeps Ink's full prop surface so specs stay interchangeable, but Pi only implements a subset. Every prop that is declared but not honored comes back in the tool result as a warning.
- **No flexbox.** `Box` supports `flexDirection`, `gap`, `alignItems`, `justifyContent`, padding, borders, and a `width` hint, but not `flexWrap` or absolute positioning. Long rows are re-rendered at their allocated width so text wraps rather than being cut.
- **`justifyContent` needs a main axis.** It works horizontally. In a column there is no fixed height to distribute into, so it is reported and children stack from the top.
- **Colors are literal ANSI.** Named terminal colors (`red`, `green`, `cyan`, `gray`, and `*Bright` variants) plus `#rgb` / `#rrggbb` / `rgb(r,g,b)`. An unsupported color string is reported and the text is left unstyled. Pi's theme tokens are not used, because the specs name concrete colors and Pi has no magenta/cyan/blue tokens to map them onto.
- **Markdown is a deliberate subset.** Headings, bold, italic, inline code, strikethrough, fenced code, lists, blockquotes, links, and horizontal rules. Tables and nested lists render as plain lines.
- **Ink's `exit` and `log` actions are not ported.** A Pi panel is not a standalone application, and writing to stdout would corrupt Pi's renderer.

Interactive components are driven through Pi's own keyboard handling:

| Component | Keys |
| --- | --- |
| `Select` | `↑`/`↓` moves, `Enter` commits |
| `MultiSelect` | `↑`/`↓` moves, `Space` toggles, `Enter` submits (honors `min`/`max`) |
| `TextInput` | printable keys type, `Backspace` deletes, `Enter` submits |
| `ConfirmInput` | `y` / `n` (labels configurable) |
| `Tabs` | `←`/`→` changes the bound tab |
| any | `Tab` / `Shift+Tab` cycles focus, `Esc` closes the panel |

## Composition (optional)

`compose_ui` uses json-render's catalog-constrained composition: you supply **atomic candidates** — a component name, concrete prop values, and a description — and TypeSafe's Jev decision model chooses which to include, in what order, and where. Jev never invents prop values and never executes actions; code owns the workflow.

```jsonc
{
  "prompt": "Show a deployment overview for eu-west-1.",
  "candidates": [
    {
      "id": "panel",
      "description": "Outer container for the panel.",
      "root": true,
      "element": { "type": "Box", "props": { "flexDirection": "column", "gap": 1 } }
    },
    {
      "id": "title",
      "description": "Panel title text.",
      "element": { "type": "Text", "props": { "text": { "$state": "/title" }, "bold": true } }
    }
  ],
  "state": { "title": "Deployments" }
}
```

Requirements and caveats:

- **Credentials.** In the default `auto` mode the tool uses whichever key is present, preferring TypeSafe direct:
  - `TYPESAFE_API_KEY` → posts to `https://api.typesafe.ai/v1/systemone` through this package's own adapter. No Vercel account needed.
  - `AI_GATEWAY_API_KEY` → posts to Vercel AI Gateway through core's built-in evaluator. This requires a Vercel team with a payment method on file and the `typesafe-ai` provider enabled.

  Restart Pi after setting a key. Set `composition.provider` to `typesafe` or `gateway` to pin one transport; a pinned provider never silently falls back to the other.
- The tool is only registered when a usable key is present, so it costs nothing in the prompt otherwise.
- Candidate props that read `$state` must resolve against `state`, or the composer rejects the candidates before it ever calls the evaluation endpoint.
- The upstream API is **experimental** (`experimental_composeSpec` / `experimental_createEvaluator`) and may change in any release. `@json-render/core` is therefore pinned to an exact version, the imports are dynamic, and the functions are feature-detected: if a future release removes them, `compose_ui` reports that and `render_ui` keeps working.
- Composition failures are reported, never retried silently. The tool result tells the model to author the spec itself with `render_ui` instead.

### Transports

The `typesafe` transport exists because core hard-codes Vercel AI Gateway's endpoint and exposes no base URL. Rather than patching core, this package injects a `fetch` through core's own `fetch` option: it rewrites the request to TypeSafe's endpoint, adds the `model` field TypeSafe requires, and folds TypeSafe's `answers[].confidence` and `usage.input_tokens` back into the shape core validates. TypeSafe's endpoint speaks the same `{ state, questions }` protocol and the same `choice` question type, so no prompt or candidate changes are involved.

## Configuration

`<Pi agent dir>/extensions/pi-gen-ui/config.json` (`PI_CODING_AGENT_DIR` is honored):

```json
{
  "enabled": true,
  "maxResultLines": 60,
  "interactiveView": "auto",
  "composition": {
    "enabled": true,
    "provider": "auto",
    "model": "",
    "apiKeyEnv": "",
    "endpoint": "",
    "timeoutMs": 10000
  }
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | Whether `render_ui` renders panels at all. |
| `maxResultLines` | Transcript lines a tool result shows before it collapses behind an expand hint. |
| `interactiveView` | `auto` opens the panel only for specs with interactive components, `always` always opens it, `never` never does. A per-call `interactive` argument overrides it. |
| `composition.enabled` | Whether `compose_ui` is offered. |
| `composition.provider` | `auto` (default) prefers TypeSafe and falls back to the gateway; `typesafe` and `gateway` pin one transport. |
| `composition.model` | Evaluation model id. Empty uses the provider default: `jev-latest` for TypeSafe, `typesafe-ai/jev` for the gateway. |
| `composition.apiKeyEnv` | Environment variable holding the key. Empty uses the provider default (`TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`). |
| `composition.endpoint` | TypeSafe endpoint override. Empty uses `https://api.typesafe.ai/v1/systemone`. |
| `composition.timeoutMs` | Per-evaluation timeout. |

The commands:

```text
/config:gen-ui                    # open the configuration panel
/config:gen-ui status             # print the effective configuration
/config:gen-ui enable|disable     # master switch for both tools
/config:gen-ui reset              # restore defaults
/config:gen-ui provider <auto|typesafe|gateway>
/config:gen-ui model <id>         # "default" restores the transport default
/config:gen-ui composition <on|off>
/config:gen-ui catalog            # regenerate the component reference and print its path
/gen-ui                           # alias
```

A bare command opens a `SettingsList` panel: arrows move, Enter/Space flips a toggle, Enter opens a submenu, Esc closes. The model row has a filter input above the list because `SelectList`'s own filter only matches a prefix. Changes made from the panel or the command take effect immediately, with no `/reload`; only hand-editing `config.json` still needs one.

## How the model learns the catalog

The full component reference is **not** injected into the system prompt. It is generated from the same catalog the renderer uses — so it cannot drift from validation — written to `<Pi agent dir>/extensions/pi-gen-ui/catalog.md`, and named in the `render_ui` tool description. The model reads it with the normal `read` tool only when it actually builds a UI.

That keeps the always-on prompt cost to a short tool description plus a path, instead of roughly 5.7k tokens of component documentation on every turn. Rejected specs come back with the structural issues, the prop issues, and the reference path, so the model can self-correct.

## Limits

- Rendering requires Pi's TUI. In RPC/JSON/print mode the tools still validate and return a summary, but no panel is drawn.
- Interactive components only receive input while the overlay is open, so keep them near the top level rather than inside collapsed or repeated branches.
- Only the `setState`, `pushState`, and `removeState` actions are built in. `ActionBinding.confirm`, `onSuccess`, and `onError` are reported as unsupported rather than half-implemented.

## Development

```bash
npm test
npm run typecheck
```

Tests are deterministic: no network, no API key, no live model. The composition path is exercised against an injected fake gateway.

## Attribution

Component names, prop vocabularies, and the spec grammar follow [vercel-labs/json-render](https://github.com/vercel-labs/json-render) (Apache-2.0). This package is an independent Pi renderer and does not embed Ink or React.

## License

[MIT](../../LICENSE)
