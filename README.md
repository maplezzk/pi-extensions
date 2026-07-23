# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A small collection of composable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

## Packages

Each package is independently installable and keeps its detailed behavior, configuration, examples, and tests in its own README.

| Package | Description | Documentation |
| --- | --- | --- |
| [`pi-distill`](./packages/pi-distill) | Compacts verbose output from every active object-schema tool before it consumes the context window. | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-tool-supervisor`](./packages/pi-tool-supervisor) | Reviews `edit` and `write` changes against matching project rules and returns structured findings. | [English](./packages/pi-tool-supervisor/README.md) · [中文](./packages/pi-tool-supervisor/README.zh-CN.md) |
| [`pi-metrics`](./packages/pi-metrics) | Shows a live session elapsed timer in the working spinner plus per-turn and total run summaries. | [English](./packages/pi-metrics/README.md) · [中文](./packages/pi-metrics/README.zh-CN.md) |
| [`pi-models-discovery`](./packages/pi-models-discovery) | Discovers models from `{baseUrl}/models` for providers marked with `discoverModels` in models.json, with a persistent startup cache and a manual refresh command. | [English](./packages/pi-models-discovery/README.md) · [中文](./packages/pi-models-discovery/README.zh-CN.md) |
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | Provides shared locale selection, catalog loading, interpolation, and the `/pi-language` command. | [English](./packages/pi-extensions-i18n/README.md) · [中文](./packages/pi-extensions-i18n/README.zh-CN.md) |
| [`pi-extensions-tool-display`](./packages/pi-extensions-tool-display) | Provides the actual Pi tool-display host plus the shared result-rendering protocol and component helpers. | [English](./packages/pi-extensions-tool-display/README.md) · [中文](./packages/pi-extensions-tool-display/README.zh-CN.md) |
| [`@maplezzk/pi-dynamic-workflows`](./packages/pi-dynamic-workflows) | Claude-Code-style dynamic workflow orchestration with `meta`/`phase()`/`agent()`/`parallel()`/`pipeline()` primitives, configurable via `/workflow-config`. Fork of michaelliv/pi-dynamic-workflows. | [English](./packages/pi-dynamic-workflows/README.md) · [中文](./packages/pi-dynamic-workflows/README.zh-CN.md) |
| [`@maplezzk/pi-interactive-subagents`](./packages/pi-interactive-subagents) | Non-blocking interactive subagents in multiplexer panes with live status widget, `/plan` and `/iterate` workflows. Fork of HazAT/pi-interactive-subagents. | [English](./packages/pi-interactive-subagents/README.md) · [中文](./packages/pi-interactive-subagents/README.zh-CN.md) |

## Install everything

Requirements: Pi with the compatible extension API and Node.js 22 or newer.

```bash
pi install git:github.com/maplezzk/pi-extensions
```

The repository root is also a Pi package. Its manifest loads every `packages/*/index.ts`, so the command above installs all current extensions and automatically includes new packages added to this repository.

Reload Pi after installation:

```text
/reload
```

To install a single package, use its npm package name:

```bash
pi install npm:<package-name>
```

## Configuration

Extensions keep configuration under the standard Pi agent directory:

```text
~/.pi/agent/extensions/<package-name>/config.json
```

See [`packages/`](./packages) for package-level configuration examples and documentation.

## Development

```bash
npm install
npm run check
```

The check command runs workspace type checks, tests, and the portability/i18n gates.

## License

[MIT](./LICENSE)
