# pi-naming

Configurable Pi session naming and manual terminal naming in one package.

[中文文档](./README.zh-CN.md)

## Install

```bash
pi install npm:pi-naming
```

Run `/reload` after installation or configuration changes. This package must be published before npm installation is available.

## Features

- **Automatic session naming:** the first real input in a new unnamed session triggers one background request to the current model. Titles prefer 10 characters and are capped at 15 Unicode code points. Only the Pi session name changes; workspace and tab names never change automatically. Existing manual names are preserved.
- **`/rename:workspace [name]`:** manually rename the terminal workspace. Without a name, generate a title from the current session's user messages, then rename the workspace. Synchronize the Pi session name only after terminal renaming succeeds.
- **`/rename:tab <name>`:** manually rename the terminal tab without changing the Pi session name or requesting a title.

Title requests time out after 10 seconds. Results from a replaced or reloaded session are discarded; later manual rename commands supersede pending earlier commands. Model, authentication and terminal failures are reported rather than treated as success.

## Configuration

Use `<pi-agent-dir>/extensions/pi-naming/config.json` (`PI_CODING_AGENT_DIR` is respected):

```json
{
  "automaticNaming": true,
  "workspaceRename": true,
  "tabRename": true
}
```

Each switch is independent and defaults to `true`. Disabled features do not register their commands/hooks. Set both terminal switches to `false` to use session naming alone; the terminal module is not loaded. A missing file uses defaults; an invalid file is reported and no naming features are registered. Fix it and `/reload`.

This package does not read configuration from the previous experimental `pi-session-tools` or `pi-terminal-rename` implementation. No installed configuration is migrated automatically.

## Dependencies and boundaries

- Title generation is internal to this package and uses `pi-ai` with the current Pi model and authentication.
- Terminal operations use `pi-terminal-mux`. Unsupported, disabled and failed operations never report success. Automatic naming works without a terminal backend.
- No dependency on `pi-session-tools`: conversation squash and output caching remain there.

Backend opt-ins remain owned by terminal-mux:

- `PI_SUBAGENT_RENAME_TMUX_WINDOW=1` for tmux window naming.
- `PI_SUBAGENT_RENAME_TMUX_SESSION=1` for tmux session naming.
- `PI_SUBAGENT_RENAME_HERDR_WORKSPACE=1` for Herdr workspace naming.

The actual terminal target varies by backend (pane, window, tab, workspace, session or terminal). Before publishing this package, its terminal-mux dependency must require a released version containing the rename-result API.

## Localization

Runtime messages and prompts are available in Chinese and English through `pi-extensions-i18n`.
