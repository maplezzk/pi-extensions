# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![pi-distill](https://img.shields.io/npm/v/pi-distill?label=pi-distill)](https://www.npmjs.com/package/pi-distill)
[![pi-tool-supervisor](https://img.shields.io/npm/v/pi-tool-supervisor?label=pi-tool-supervisor)](https://www.npmjs.com/package/pi-tool-supervisor)
[![pi-extensions-i18n](https://img.shields.io/npm/v/pi-extensions-i18n?label=pi-extensions-i18n)](https://www.npmjs.com/package/pi-extensions-i18n)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Small, composable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

These packages focus on three practical gaps around tool-heavy coding sessions:

- keeping large tool results from consuming the agent's context unnecessarily;
- reviewing file changes against project rules immediately after `edit` and `write`;
- giving independently developed extensions a consistent bilingual runtime.

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Why this project exists

Pi is intentionally small and extensible. That makes it a good foundation for personal workflows, but it also leaves application-level concerns to extensions:

1. **Long output creates context pressure.** Logs, search results, and generated files can be much larger than the useful information the agent needs for its next decision.
2. **A successful edit is not the same as a reviewed edit.** An agent can write syntactically valid code that still violates local rules, file conventions, or review expectations.
3. **Extension UX drifts without shared infrastructure.** Each extension should not have to reimplement locale selection, catalog validation, fallback behavior, and configuration paths.

`pi-extensions` addresses these problems with independent npm packages. Each package can be installed on its own, uses Pi's native extension events, and avoids replacing or registering duplicate built-in tools.

## Packages

| Package | What it does | Problem it addresses | Documentation |
| --- | --- | --- | --- |
| [`pi-distill`](./packages/pi-distill) | Distills `bash`, `read`, `grep`, and `find` results according to the tool's `outputPrompt`; preserves raw output when explicitly requested and spills oversized content to a temporary file. | Large tool results crowd the context window and make the next model turn slower or less reliable. | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-tool-supervisor`](./packages/pi-tool-supervisor) | Captures the before/after file state for `edit` and `write`, loads matching rule files, and asks one or more configured models for a structured review. | File changes can pass the tool call but still miss project-specific safety, architecture, or style rules. | [English](./packages/pi-tool-supervisor/README.md) · [中文](./packages/pi-tool-supervisor/README.zh-CN.md) |
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | Shared `zh-CN` / `en-US` / `auto` locale selection, catalog loading, validation, interpolation, and the `/pi-language` command. | Independently shipped extensions otherwise duplicate localization and configuration logic or expose inconsistent user-facing messages. | [English](./packages/pi-extensions-i18n/README.md) · [中文](./packages/pi-extensions-i18n/README.zh-CN.md) |

The packages are deliberately separate. Install only the behavior you need; `pi-extensions-i18n` is pulled in as a shared dependency when required.

## Install

Requirements: Pi with the compatible extension API and Node.js 22 or newer.

```bash
pi install npm:pi-distill
pi install npm:pi-tool-supervisor
```

Install the shared localization package explicitly when you want the `/pi-language` command without the other extensions:

```bash
pi install npm:pi-extensions-i18n
```

Reload Pi after installation:

```text
/reload
```

Useful first-run commands:

```text
/pi-language        # choose zh-CN, en-US, or auto
/pi-distill         # inspect or edit distillation settings
/pi-tool-supervisor # inspect or edit file-review settings
```

## How the extensions work together

```text
Pi tool call
    │
    ├── bash/read/grep/find ──► pi-distill ──► compact result + audit details
    │                                              └─► temporary file for oversized content
    │
    └── edit/write ───────────► pi-tool-supervisor ─► diff + rule-based model review
                                                       └─► review audit appended to result

Shared runtime: pi-extensions-i18n ──► locale selection + catalog-backed messages
```

Both behavior extensions use Pi's `tool_call` and `tool_result` events. They do not register same-named replacements for Pi's tools, so they can be composed with other display or workflow extensions.

## Configuration

Configuration is file-first and portable:

```text
~/.pi/agent/extensions/<package-name>/config.json
```

See the checked-in examples:

- [`pi-distill/config.example.json`](./packages/pi-distill/config.example.json)
- [`pi-tool-supervisor/config.example.json`](./packages/pi-tool-supervisor/config.example.json)

Each package documents its environment variables, defaults, compatibility behavior, and failure modes in its package README. In general, a missing or invalid optional configuration degrades to a diagnostic or no-op instead of preventing Pi from starting.

## Important boundaries

- `pi-distill` is a context-management extension, not a replacement for Pi's permission model or a guarantee that a summary retains every detail. Use the strict `RAW` output prompt when exact output is required.
- `pi-tool-supervisor` is a post-edit review layer. It records findings and returns them to the agent; it does not roll back a successful edit or provide OS-level sandboxing.
- The extensions do not assume a particular home directory, daemon, terminal multiplexer, notification service, or private network. Paths and environment differences are resolved at runtime.

## Development

```bash
npm install
npm run typecheck
npm test
npm run check   # typecheck + tests + local-binding gate
```

The repository is a small npm workspace under `packages/`. Each publishable package contains its own entrypoint, tests, configuration example, and README. Tests do not require a live reviewer or summarizer model.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Use [Conventional Commits](https://www.conventionalcommits.org/) for changes.
2. CI checks the pull request.
3. Release Please opens or updates a release PR with package versions and changelogs.
4. Merging the release PR publishes changed packages to npm with OIDC trusted publishing and provenance.

## Contributing

Issues and pull requests are welcome. Before opening a change:

- explain the user problem and the observable behavior you want to improve;
- add or update focused tests for deterministic logic;
- keep user-facing messages in the bilingual i18n catalogs;
- avoid machine-local paths, private services, and undeclared runtime dependencies;
- run `npm run check` locally.

## License

[MIT](./LICENSE)
