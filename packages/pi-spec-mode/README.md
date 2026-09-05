# pi-spec-mode

A spec-driven development workflow extension for the [Pi coding agent](https://pi.dev). It keeps requirements, design, tasks, and verification artifacts in the project, advances through explicit stages, and protects writes according to the current stage.

[中文文档](./README.zh-CN.md)

## Features

- Persists specs under `.pi/specs/<slug>/` with a plugin-managed `state.json`.
- Supports `strict` approval for every planning and verification stage, or `quick` acceptance for requirements/design while retaining human approval before implementation.
- Requires `spec_submit` after an artifact is written; submission validates the document and records its SHA-256 without approving it.
- Binds approvals to document hashes and reopens the affected stage when an approved artifact changes or disappears, clearing downstream approvals.
- Protects `state.json` and stage-inappropriate files through the native `tool_call` hook.
- Restores the active spec and tool set after session reload and tree navigation.
- Displays a Workflow-style progress widget in TUI mode and a plain-text status in RPC mode.

## Install

```bash
pi install npm:pi-spec-mode
```

Then run `/reload` in Pi.

## Commands

```text
/spec new <slug> [--title "title"]   Create and activate a spec
/spec use <slug>                       Activate an existing spec
/spec status                           Show and refresh progress
/spec approve                          Confirm the current submitted stage
/spec revise <artifact>                Reopen a stage and clear downstream approvals
/spec continue                         Continue approved implementation tasks
/spec stop                             Exit spec mode and restore the previous tools
```

`<artifact>` is one of `requirements`, `design`, `tasks`, or `verification`.

## Workflow

```text
strict: requirements → approve → design → approve → tasks → approve → implementation → verification → approve → complete
quick:  requirements → design → tasks → approve → implementation → verification → approve → complete
```

The user must explicitly approve submitted documents in interactive mode. Headless mode never auto-approves. In implementation, the extension tracks `[DONE:TASK-id]` markers in assistant responses and moves to verification after every task in `tasks.md` is complete.

## Write policy

- Planning stages: bash is blocked; only the current artifact may be edited.
- Implementation: source files may be edited, but `.pi/specs/<slug>/` remains protected; only `tasks.md` may be updated.
- Verification: bash remains available only when it was active before spec mode, and only `verification.md` may be edited.
- `state.json` is always managed by the extension and cannot be written through `write` or `edit`.

## Configuration

There are no runtime settings or configuration switches. `config.example.json` is intentionally empty. Use the `/spec` commands and project artifacts instead.

## Development

```bash
npm run typecheck
npm test
npm run check
```

The package includes the `configure-pi-spec-mode` skill for operational diagnosis. It does not start subagents or workflows, and it does not depend on Plannotator.

## Localization

User-facing command, tool, status, prompt, and template text is provided in both `zh-CN` and `en-US` through `pi-extensions-i18n`.

## License

[MIT](../../LICENSE)
