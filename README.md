# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A small collection of composable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Packages

Each package is independently installable and keeps its detailed behavior, configuration, examples, and tests in its own README. Every extension package also publishes a `SKILL.md` that Pi loads to guide agents through configuration and verification.

| Package | Description | Documentation |
| --- | --- | --- |
| [`pi-safety-guards`](./packages/pi-safety-guards) | Configurable deterministic Bash, path and Maven guards. | [English](./packages/pi-safety-guards/README.md) · [中文](./packages/pi-safety-guards/README.zh-CN.md) |
| [`pi-distill`](./packages/pi-distill) | Compacts verbose output from every active object-schema tool before it consumes the context window. | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-tool-supervisor`](./packages/pi-tool-supervisor) | Reviews selected tools before or after execution against matching rules, with diff-aware handling for `edit` and `write`. | [English](./packages/pi-tool-supervisor/README.md) · [中文](./packages/pi-tool-supervisor/README.zh-CN.md) |
| [`pi-metrics`](./packages/pi-metrics) | Shows a live session elapsed timer in the working spinner plus per-turn and total run summaries. | [English](./packages/pi-metrics/README.md) · [中文](./packages/pi-metrics/README.zh-CN.md) |
| [`pi-models-discovery`](./packages/pi-models-discovery) | Discovers models from `{baseUrl}/models` for providers marked with `discoverModels` in models.json, with a persistent startup cache and a manual refresh command. | [English](./packages/pi-models-discovery/README.md) · [中文](./packages/pi-models-discovery/README.zh-CN.md) |
| [`pi-session-tools`](./packages/pi-session-tools) | Caches the full pre-filter output of bash `grep`/`tail`/`head` pipelines and provides `session_log` / `session_squash` for squashing long conversations with main-agent handoff summaries. | [English](./packages/pi-session-tools/README.md) · [中文](./packages/pi-session-tools/README.zh-CN.md) |
| [`pi-session-resources`](./packages/pi-session-resources) | Collects files, browser URLs, and PR/MR links from successful tool activity and exposes them through a clickable, tabbed `#` resource picker above the editor. | [English](./packages/pi-session-resources/README.md) · [中文](./packages/pi-session-resources/README.zh-CN.md) |
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | Provides shared locale selection, catalog loading, interpolation, and the `/config:language` command. | [English](./packages/pi-extensions-i18n/README.md) · [中文](./packages/pi-extensions-i18n/README.zh-CN.md) |
| [`pi-extensions-tool-display`](./packages/pi-extensions-tool-display) | Provides the actual Pi tool-display host plus the shared result-rendering protocol and component helpers. | [English](./packages/pi-extensions-tool-display/README.md) · [中文](./packages/pi-extensions-tool-display/README.zh-CN.md) |
| [`@maplezzk/pi-dynamic-workflows`](./packages/pi-dynamic-workflows) | Claude-Code-style dynamic workflow orchestration with `meta`/`phase()`/`agent()`/`parallel()`/`pipeline()` primitives, configurable via `/config:workflow`. Fork of michaelliv/pi-dynamic-workflows. | [English](./packages/pi-dynamic-workflows/README.md) · [中文](./packages/pi-dynamic-workflows/README.zh-CN.md) |
| [`@maplezzk/pi-interactive-subagents`](./packages/pi-interactive-subagents) | Non-blocking interactive subagents in multiplexer panes with live status widget, `/plan` and `/iterate` workflows. Fork of HazAT/pi-interactive-subagents. | [English](./packages/pi-interactive-subagents/README.md) · [中文](./packages/pi-interactive-subagents/README.zh-CN.md) |

Extension management slash commands use the `/config:<feature>[-action]` convention. Legacy names remain as compatibility aliases where a command was renamed; `/plan`, `/iterate`, and `/subagent` are intentionally short workflow shortcuts.

## Install everything

Requirements: Pi with the compatible extension API and Node.js 22 or newer.

```bash
pi install git:github.com/maplezzk/pi-extensions
```

The repository root is also a Pi package. Its manifest loads extension entrypoints under `packages/*/index.ts` while excluding library-only packages such as `pi-terminal-mux`, so the command above installs all current extensions without trying to load shared libraries as extensions.

Reload Pi after installation:

```text
/reload
```

To install a single package, use its npm package name:

```bash
pi install npm:<package-name>
```

## Configuration

Most configurable extensions keep state under the Pi agent directory; exact paths, command names, environment precedence, and verification steps differ by package.

Pi loads each installed extension package's `SKILL.md` so an agent can follow the package-specific configuration workflow. See [`packages/`](./packages) for configuration examples and detailed documentation.

## Development

```bash
npm install
npm run check
```

The check command runs workspace type checks, tests, and the portability/i18n gates.

## License

[MIT](./LICENSE)
