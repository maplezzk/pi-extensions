# pi-dynamic-workflows

Claude-Code-style dynamic workflow orchestration for Pi.

> **Fork notice:** This package is a fork of [michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) (MIT license). Full credit to the original author **michaelliv** for the design and implementation. Changes in this fork: monorepo integration, i18n support, and config migration from environment variables to a slash command.

## Features

- Define multi-agent workflows as plain JavaScript scripts with `meta`, `phase()`, `agent()`, `parallel()`, and `pipeline()` primitives
- Static validation of workflow scripts via acorn AST parsing
- Optional subagent backend via `pi-interactive-subagents` for real tool access per agent
- Async background execution mode with live status widget
- Configurable via `/workflow-config` slash command (persisted to JSON)

## Installation

```bash
pi install @maplezzk/pi-dynamic-workflows
```

## Configuration

Run `/workflow-config` to interactively configure:

- **Execution backend**: `workflow` (built-in in-process agent) or `subagent` (requires `pi-interactive-subagents`)
- **Async mode**: run workflows in the background with a live status widget

Config is persisted to `~/.pi/agent/extensions/pi-dynamic-workflows/config.json`.

Environment variables are supported as fallback only:

| Variable | Values | Effect |
|---|---|---|
| `PI_WORKFLOW_BACKEND` | `subagent` | Use subagent backend (fallback) |
| `PI_WORKFLOW_ASYNC` | `true` | Enable async mode (fallback) |

JSON config takes priority over environment variables.

## Usage

```js
// In a workflow script passed to the workflow tool:
export const meta = {
  name: 'my_workflow',
  description: 'Does something useful',
  phases: [{ title: 'Phase 1' }]
};

phase('Phase 1');
const result = await agent('Analyze the codebase', {
  label: 'code analysis',
  schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
});
```

## License

MIT — see original repository for details.
