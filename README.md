# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A small collection of composable extensions for the [Pi coding agent](https://github.com/earendil-works/pi).

> 中文文档：[README.zh-CN.md](./README.zh-CN.md)

The extensions in this repository help with common tool-heavy coding workflows:

- compacting verbose tool output before it consumes the context window;
- reviewing `edit` and `write` changes against project rules;
- sharing consistent bilingual runtime messages across independently shipped extensions.

Each extension is maintained as an independent package under [`packages/`](./packages). Package-specific behavior, configuration, examples, and tests are documented in that package's README.

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
