# pi-safety-guards

Configurable Bash safety rules for Pi: select presets, override individual rules, or add your own matchers. No build system, IDE, deletion utility or private workspace is required.

[中文文档](./README.zh-CN.md)

## Install

```bash
pi install npm:pi-safety-guards
```

This package must be published before npm installation is available. Reload Pi after installation or configuration changes.

## Default behavior

Without configuration, only the `destructive-operations` preset is active. It asks for confirmation before the supported destructive commands; it does **not** require trash, forbid Maven, force an IDE, restrict directories, or trust a skills directory.

| Preset | Rule ID | Match | Default action |
| --- | --- | --- | --- |
| `destructive-operations` | `filesystem.delete` | Executed `rm` or `rmdir` | confirm |
| `destructive-operations` | `filesystem.format` | Executed `mkfs` or `mkfs.*` | confirm |
| `destructive-operations` | `filesystem.ownership` | Executed `chown` | confirm |
| `destructive-operations` | `shell.fork-bomb` | Supported colon-function fork-bomb syntax | confirm |
| `workspace-boundary` (opt-in) | `paths.workspace` | Explicit Bash paths outside `.` | block |

The command parser accounts for supported wrappers, literal nested shells, substitutions and redirects. Text such as `echo 'rm file'` or a subcommand such as `git rm` does not count as executing `rm`.

## Configuration

File: `<pi-agent-dir>/extensions/pi-safety-guards/config.json`. `PI_CODING_AGENT_DIR` is respected. Configuration is loaded once per extension load; use `/reload` after changes.

```json
{
  "presets": ["destructive-operations"],
  "rules": []
}
```

- Omitted `presets` selects the default preset. An explicit empty list selects none.
- `rules` overrides selected preset rules by stable `id` or adds new rules. Duplicate IDs in this list are rejected.
- An existing rule can override `action`, `match`, `message`, or set `enabled: false`.
- New enabled rules require `id`, `action` and `match`.
- Unknown fields, unknown presets and malformed rules are errors, not silently ignored.
- Empty presets and rules disable checking and report that no protection is active.

### Actions

- `warn`: allow the operation and append a rule warning to its tool result, including in modes without a UI.
- `confirm`: ask once for the matching rules. If prompting is unavailable or the user does not confirm, block.
- `block`: reject the operation without prompting.

When multiple rules match, `block` wins over `confirm`, then `warn`. All matching IDs are reported. There is no order-dependent allow rule that bypasses later checks. Suggestions are plain text; the extension never executes a replacement command.

```json
{
  "presets": ["destructive-operations"],
  "rules": [
    { "id": "filesystem.delete", "action": "block", "message": "Use the deletion tool selected by your team." },
    { "id": "filesystem.ownership", "enabled": false },
    { "id": "team-build", "action": "confirm", "match": { "commands": ["custom-build"] } }
  ]
}
```

`message` accepts either a non-empty local string or an object with both `zh-CN` and `en-US`. See [the team-policy example](./examples/team-policy.json) for an optional build-tool/deletion policy expressed entirely as data, not a default.

### Matchers

Exactly one matcher is allowed per rule:

| `match` | Meaning |
| --- | --- |
| `{ "commands": ["tool", "wrapper"] }` | Exact executed command basenames, not substring matching of raw text |
| `{ "detector": "disk-format" }` | Existing format-command detector |
| `{ "detector": "fork-bomb" }` | Existing colon-function detector |
| `{ "detector": "in-place-edit" }` | `sed` in-place flags; opt-in, not forbidden by default |
| `{ "detector": "home-root" }` | An unquoted standalone `~` argument; opt-in |
| `{ "detector": "root-search" }` | A `find` argument equal to `/`; opt-in |
| `{ "outsideRoots": [".", "../shared"] }` | Explicit paths outside the configured roots |
| `{ "module": "./rules/deploy.mjs" }` | A trusted local matcher module |

### Directory policies

The directory preset is opt-in. Relative roots resolve against the current Pi working directory; absolute paths and `~/` are supported. Only supplied roots are trusted: `cwd`, `/tmp`, `/var`, skills directories, PATH executables and shell device paths are not silently added. In the preset, `.` explicitly allows `cwd`. Add necessary roots or device paths such as `/dev/null` yourself.

No other extension's private session entries are read. Integrations can supply their own roots through a custom matcher using the exported `findOutOfScopeBashPaths(command, cwd, roots)` helper.

### Local rule modules

Paths resolve against the directory containing `config.json`, never against model input. Use a local JavaScript ES module with a default matcher:

```js
export default ({ commands }) => commands.some(
  ({ name, args }) => name === "example-deploy" && args.includes("--production"),
);
```

The matcher receives a frozen `{ command, cwd, commands: [{ name, args }] }` summary and returns a boolean or `Promise<boolean>`. It does not receive Pi's execution API. Import `RuleContext` / `RuleMatcher` types from `pi-safety-guards` when authoring typed integrations.

Only explicitly configured enabled modules are loaded. Loading errors, thrown matcher errors, non-boolean results and asynchronous work exceeding five seconds block the operation with the rule ID. Reload reads updated module files. Modules run with full process permissions: the timeout cannot interrupt a synchronous infinite loop or roll back side effects. Only load trusted code; this is not a sandbox.

## Limits and errors

This package observes Pi's `bash` tool, not every shell, custom tool, direct user shell or program-internal file operation. It does not implement PowerShell, simulate every working-directory change, or resolve arbitrary variable-generated paths. Path checks cover statically identifiable references and known symlinks; they are not OS-level access control. The default preset does not claim to detect every dangerous command, including all `dd`/`chmod` forms.

With rules enabled, malformed Bash or rule failures block rather than silently pass. A missing config file uses the default preset; a damaged config blocks Bash until fixed and reloaded. The former experimental `maven`, `javaSkill`, `dangerCommands` and `bashDirectoryScope` switches are not accepted: move that policy into rules explicitly.

## Verify

```bash
npm run check
```

Tests use parsed command fixtures, fake Pi handlers and temporary matcher modules. Real terminal confirmation and model operation need separate smoke tests. Runtime default messages are available in Chinese and English through `pi-extensions-i18n`.
