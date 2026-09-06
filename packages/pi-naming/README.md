# pi-naming

Independently configurable Pi session naming and manual terminal naming.

[中文](./README.zh-CN.md)

## Installation

```bash
pi install npm:pi-naming
```

The package must be published before npm installation is available. Run `/reload` after installation or configuration changes.

## Features

- **Automatic session naming**: the first real user input in a new, unnamed session triggers a background title request. It does not overwrite an existing name or rename the terminal.
- **`/rename:workspace [name]`**: use the explicit name, or generate one from user messages on the current session branch. Sync the Pi session only after a successful terminal rename and only when `syncSessionName` is enabled.
- **`/rename:tab <name>`**: rename only the terminal tab, without calling a model or changing the Pi session.

Session switches and reloads invalidate old results. Later manual rename commands supersede pending commands. Unsupported, disabled and failed terminal operations are reported rather than treated as success.

## Configuration

File: `<pi-agent-dir>/extensions/pi-naming/config.json`; respects `PI_CODING_AGENT_DIR`.

```json
{
  "automaticNaming": true,
  "workspaceRename": true,
  "tabRename": true,
  "syncSessionName": true,
  "title": {
    "maxLength": 15,
    "preferredLength": 10,
    "language": "auto",
    "instructions": "",
    "timeoutMs": 10000
  }
}
```

The three feature switches are independent and default to enabled. Turning off both terminal features avoids loading the terminal module. Missing configuration uses defaults; invalid configuration reports an error and registers no naming features until corrected and reloaded.

| Field | Default | Meaning |
| --- | --- | --- |
| `syncSessionName` | `true` | Sync the Pi session after a successful workspace rename; disable to rename only the terminal |
| `title.maxLength` | `15` | Maximum generated title length in Unicode code points; longer output is truncated |
| `title.preferredLength` | `10` | Preferred length requested from the model; must not exceed the maximum |
| `title.language` | `"auto"` | Use the dominant message language, or specify a language such as `English` or `日本語` |
| `title.instructions` | `""` | Additional style instructions appended to the naming system prompt; not a template or executable code |
| `title.timeoutMs` | `10000` | Title request timeout in milliseconds |

Lengths and timeout must be positive safe integers; timeout must not exceed `2147483647` milliseconds. Unknown fields, empty language and invalid values are rejected. Additional instructions do not bypass single-line normalization or the length limit.

For longer English titles, set `title.maxLength` to `60`, `title.preferredLength` to `40`, and `title.language` to `"English"`. These settings apply to automatic session titles and generated workspace names, not explicitly supplied names. Generation uses Pi's current model and authentication; there is no separate model configuration.

## Terminal support

Terminal operations use `pi-terminal-mux`; automatic session naming works without a terminal backend. The title generator is internal to this package; it does not depend on `pi-session-tools`.

Backend opt-ins are managed by terminal-mux:

- tmux window: `PI_SUBAGENT_RENAME_TMUX_WINDOW=1`
- tmux session: `PI_SUBAGENT_RENAME_TMUX_SESSION=1`
- Herdr workspace: `PI_SUBAGENT_RENAME_HERDR_WORKSPACE=1`

Actual targets vary by backend: pane, window, tab, workspace, session or terminal. Before publication, the terminal-mux dependency minimum must match a published version providing the rename-result API.

## Localization

Runtime messages and built-in prompts use `pi-extensions-i18n` with English and Chinese catalogs. The title language setting is independent of the UI language.
