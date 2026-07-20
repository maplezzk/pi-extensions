# pi-extensions agent and contributor guide

This repository contains small, independently installable extensions for the [Pi coding agent](https://github.com/earendil-works/pi). The project is public and portable: changes must work without access to a maintainer's machine, private services, or local daemon.

## Repository map

```text
pi-extensions/
├── packages/
│   ├── pi-extensions-i18n/      # Shared locale and catalog runtime
│   ├── pi-extensions-tool-display/ # Tool-display host and shared rendering protocol
│   ├── pi-distill/              # Tool-output distillation
│   └── pi-tool-supervisor/      # Post-edit file review
├── scripts/                     # Repository checks and workspace helpers
├── .github/workflows/           # CI and release automation
├── README.md                    # English project documentation
├── README.zh-CN.md              # Chinese project documentation
├── AGENTS.md                    # This guide
└── package.json                 # Private npm workspace root
```

Each package owns its entrypoint, tests, configuration example, localization resources, and package README. The public package source of truth is this repository; consumers should install the published npm packages instead of copying package source into another project.

## Package boundaries

- `pi-distill` discovers active tools with object parameter schemas and observes their results through Pi's native `tool_call` and `tool_result` events. It does not register duplicate tools.
- `pi-tool-supervisor` reviews the actual before/after diff of `edit` and `write` against configured rule files. It reports findings but is not an operating-system sandbox or an edit rollback mechanism.
- `pi-extensions-tool-display` owns the actual Pi tool-display host, built-in tool renderer overrides, and the shared result-rendering middleware protocol. Feature packages register domain-specific panels through it.
- `pi-extensions-i18n` owns locale selection, catalog validation, interpolation, and the `/pi-language` command. Feature packages use it instead of implementing separate locale runtimes.

Keep packages composable and independently installable. Avoid coupling one extension to another extension's private implementation details or display state.

## Portability and safety

- Do not commit user-specific paths, credentials, private domains, internal service names, or machine-specific defaults.
- Resolve user directories with `os.homedir()` or Pi's standard configuration directory. Support `PI_CODING_AGENT_DIR` where the package already exposes that configuration point.
- Optional external tools must be detected at runtime and have a graceful fallback or noop path.
- Do not make network calls, model assumptions, or local daemon availability implicit in deterministic tests.
- Use configuration or injected adapters for environment-specific behavior.

## User-facing text and localization

User-visible messages, command descriptions, tool descriptions, and agent-facing prompts must be backed by a catalog containing both `zh-CN` and `en-US` entries. Use `pi-extensions-i18n`'s `createTranslator` and `loadCatalog` helpers.

Keep developer comments and implementation notes concise. Keep the English and Chinese README files separate so each language has a complete, readable entrypoint.

## Development

Requirements: Node.js 22 or newer and a compatible Pi extension runtime for manual smoke tests.

```bash
npm install
npm run typecheck
npm test
npm run check
```

`npm run check` is the repository gate. It runs type checks, package tests, packaging checks, and the local-binding policy check. Tests should be deterministic and must not require API keys, a live reviewer model, or a particular filesystem layout.

When changing a package, also inspect its package-level README and `config.example.json`. If the public behavior changes, add or update focused tests and document the configuration or compatibility impact.

## Pull requests

Use Conventional Commits such as `feat:`, `fix:`, `refactor:`, `docs:`, and `chore:`. A pull request should explain:

1. the user problem or maintenance problem;
2. the observable behavior that changed;
3. package and documentation impact;
4. validation performed, including any limitations.

Keep unrelated refactors out of a focused pull request. Run `npm run check` before requesting review.

## Releases

Versions and changelogs are managed by release-please. Merging a release PR publishes changed packages to npm through the repository's OIDC trusted-publishing workflow with provenance. Do not publish manually from a local machine unless the release procedure explicitly requires it.
