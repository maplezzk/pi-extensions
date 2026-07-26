# pi-dynamic-workflows

Claude-Code-style dynamic workflow orchestration for Pi.

> **Fork notice:** This package is a fork of [michaelliv/pi-dynamic-workflows](https://github.com/Michaelliv/pi-dynamic-workflows) (MIT license). Full credit to the original author **michaelliv** for the design and implementation. Changes in this fork: monorepo integration, i18n support, and config migration from environment variables to a slash command.

## Features

- Define multi-agent workflows as plain JavaScript scripts with `meta`, `phase()`, `agent()`, `parallel()`, and `pipeline()` primitives
- Static validation of workflow scripts via acorn AST parsing
- Optional subagent backend via `pi-interactive-subagents` for real tool access per agent
- Async background execution mode with live status widget
- Configurable via `/config:workflow` slash command (persisted to JSON)

## Installation

```bash
pi install npm:@maplezzk/pi-dynamic-workflows
```

## Configuration

Run `/config:workflow` to interactively configure:

- **Execution backend**: `workflow` (built-in in-process agent) or `subagent` (requires `pi-interactive-subagents` to be installed and loaded; each agent gets a real tool session)
- **Async mode**: run workflows in the background with a live status widget

Config is persisted to `~/.pi/agent/extensions/pi-dynamic-workflows/config.json`.

Environment variables are supported as fallback only:

| Variable | Values | Effect |
|---|---|---|
| `PI_WORKFLOW_BACKEND` | `subagent` | Use subagent backend (fallback) |
| `PI_WORKFLOW_ASYNC` | `true` | Enable async mode (fallback) |

JSON config takes priority over environment variables.

> **Note:** The `subagent` backend depends on the `pi-interactive-subagents` extension injecting its capabilities into `globalThis.__pi_subagents` at runtime. If the backend is set to `subagent` but that extension is not installed/loaded, every `agent()` call in the workflow will fail.

## Troubleshooting

### Error: the subagent execution backend requires the pi-interactive-subagents extension, which is not currently loaded

**Cause**: the workflow execution backend is set to `subagent`, but the `pi-interactive-subagents` extension is not installed or not loaded, so `globalThis.__pi_subagents` is not injected.

The `subagent` backend can be activated by either of:

- The `PI_WORKFLOW_BACKEND=subagent` environment variable
- The persisted config written by `/workflow-config` (`~/.pi/agent/extensions/pi-dynamic-workflows/config.json`)

**Fix (choose one)**:

1. Install and load the extension (keep using the subagent backend):

   ```bash
   pi install npm:@maplezzk/pi-interactive-subagents
   ```

2. Switch back to the built-in `workflow` backend: run `/config:workflow` and set the execution backend to `workflow`. The persisted config takes priority over environment variables, so this overrides `PI_WORKFLOW_BACKEND`.
3. If you enabled it via an environment variable, remove `export PI_WORKFLOW_BACKEND=subagent` from your shell config (e.g. `.zshrc` / `.zshenv`) and restart pi.

`/workflow-config` and `/pi-workflow-config` remain available as compatibility aliases.

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
