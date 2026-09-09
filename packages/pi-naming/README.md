# pi-naming

Automatic and manual naming for Pi sessions and terminals.

[中文](./README.zh-CN.md)

## Installation and usage

```bash
pi install npm:pi-naming
```

Available through npm after publication. Run `/reload` after installation or configuration changes.

- **Automatic naming**: the first real user input in a new, unnamed session generates a title in the background and applies it to the allowed session, workspace and tab targets.
- **`/rename [name]`**: supply an explicit name, or omit it to generate one from user messages on the current branch. Uses the same targets and execution path as automatic naming.
- **`/config:naming`**: open the normal TUI settings menu; use `reset` to restore defaults.
- Manual generation considers all user input on the current branch and names the main task. Explicit later corrections or goal changes take precedence; procedural follow-ups such as “continue”, “verify”, or “commit” should not overshadow the topic. Other branches, assistant replies and tool output are excluded. Automatic naming still attempts only once on the first input, not after every turn.
- Automatic results do not overwrite an existing name. Manual commands supersede pending requests; session switches and reloads discard old results and errors.
- Each target is independent. Unsupported, disabled, unidentified or failed terminal targets are reported without preventing session naming or other target updates. Non-UI modes receive Pi messages instead of silent failures.

## Configuration

File: `<pi-agent-dir>/extensions/pi-naming/config.json`; respects `PI_CODING_AGENT_DIR`.

```json
{
  "automaticNaming": true,
  "manualNaming": true,
  "targets": {
    "session": true,
    "workspace": true,
    "tab": true
  },
  "title": {
    "maxLength": 15,
    "preferredLength": 10,
    "language": "auto",
    "instructions": "",
    "timeoutMs": 10000
  }
}
```

`automaticNaming` and `manualNaming` independently control the automatic input hook and `/rename`. `targets` directly controls session, workspace and tab separately; all targets default to enabled. Disable both terminal targets for session-only naming without loading the terminal module.

| Title field | Default | Meaning |
| --- | --- | --- |
| `maxLength` | `15` | Maximum generated Unicode code points; longer output is truncated |
| `preferredLength` | `10` | Preferred length requested from the model; must not exceed the maximum |
| `language` | `"auto"` | Dominant message language, or a language such as `English` or `日本語` |
| `instructions` | `""` | Additional naming style instructions, not a template or executable code |
| `timeoutMs` | `10000` | Title request timeout in milliseconds |

Lengths and timeout must be positive safe integers; timeout must not exceed `2147483647` milliseconds. Unknown fields and invalid values are reported and disable registration. A missing file uses defaults. Explicit names are not truncated by generation settings; additional instructions cannot bypass generated title normalization or length limits.

For longer English titles use `maxLength: 60`, `preferredLength: 40`, `language: "English"`. Model and authentication come from Pi's current selection; title language is independent of UI language.

## Standalone and composed use

- `pi-terminal-mux` is an automatically installed library dependency, not a separate extension to enable. It resolves terminal targets and executes renames, without generating titles.
- No dependency on `pi-interactive-subagents` or `pi-session-tools`. Session naming works without a terminal backend.
- Launchers can provide owned terminal targets through terminal-mux's `PI_TERMINAL_RENAME_CONTEXT` protocol. Child sessions can name themselves but cannot rename a shared workspace; only explicitly granted panes/tabs are changed.
- tmux/WezTerm/Otty/Orca splits do not prove exclusive window/tab ownership. Unverified targets are skipped with an explanation rather than expanding the operation's scope.
- With `pi-interactive-subagents`, explicitly include this package's entrypoint in `subagentExtensions`. Installing it in the parent does not bypass child extension isolation.

Ordinary sessions request every enabled target with an explicit ID, including supported tmux and Herdr targets. This target-resolution path deliberately ignores the legacy `PI_SUBAGENT_RENAME_TMUX_WINDOW`, `PI_SUBAGENT_RENAME_TMUX_SESSION` and `PI_SUBAGENT_RENAME_HERDR_WORKSPACE` switches; those variables remain only for terminal-mux's older public rename APIs. A disabled `targets` entry does not run even if an environment variable is set. Missing IDs never fall back to current focus or the first tab.

`pi-naming` requires a published `pi-terminal-mux` version that exports `resolveTerminalRenameTargets` and `renameTerminalTarget`. Release-please updates workspace dependency ranges in release PRs. When one release publishes both packages, CI publishes terminal-mux first and publishes naming only after that npm publication succeeds; a naming-only release uses the already published compatible mux. Do not manually publish or preemptively raise the range to an unpublished version.

## Validation

`npm run check -w pi-naming` covers standalone/composed naming, partial failures, config validation and stale requests. Real terminal and model calls require separate verification.
