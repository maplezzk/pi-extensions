# pi-safety-guards

Bash safety rules for Pi, with selectable presets, per-rule actions and custom matchers.

[中文文档](./README.zh-CN.md)

## Install

```bash
pi install npm:pi-safety-guards
```

Run `/reload` after installation or configuration changes.

## Presets

By default, `destructive-operations` asks for confirmation before these operations:

| Preset | Rule ID | Match | Action |
| --- | --- | --- | --- |
| `destructive-operations` | `filesystem.delete` | `commands: rm, rmdir` | confirm |
| `destructive-operations` | `filesystem.format` | `commandPrefixes: mkfs` | confirm |
| `destructive-operations` | `filesystem.ownership` | `commands: chown` | confirm |
| `destructive-operations` | `shell.fork-bomb` | `commandPattern: :\(\)\s*\{` | confirm |
| `workspace-boundary` (opt-in) | `paths.workspace` | `outsideRoots: .` | block |

Matching uses parsed commands, including supported wrappers, literal nested shells, substitutions and redirects. `echo 'rm file'` and `git rm` do not count as executing `rm`; `commandPattern` is the exception and sees the raw command text.

Each preset is one plain JSON file in the package's `presets/` directory: the file name is the preset name and the file content is an array of rules, so the table above can be read directly from `presets/destructive-operations.json` and `presets/workspace-boundary.json`. Only the bundled files are loaded; `config.json` selects them by name and cannot add or replace preset files. A missing, empty or malformed preset file blocks Bash with the file path instead of silently disabling protection.

## Configuration

File: `<pi-agent-dir>/extensions/pi-safety-guards/config.json`. The agent directory respects `PI_CODING_AGENT_DIR`.

```json
{
  "presets": ["destructive-operations"],
  "rules": [
    { "id": "filesystem.delete", "action": "block" },
    { "id": "filesystem.ownership", "enabled": false },
    { "id": "example.command", "action": "confirm", "match": { "commands": ["example-command"] } }
  ]
}
```

Replace `example-command` with the command to match. See also [config.example.json](./config.example.json) and [custom-rules.json](./examples/custom-rules.json).

- `presets`: omitted selects the default preset; `[]` selects none.
- `rules`: override selected preset rules by `id` or add new ones. IDs must be unique within this list.
- Existing rules can override `action`, `match` and `message`, or use `enabled: false`.
- New enabled rules require `id`, `action` and `match`.
- `message`: optional non-empty text or an object containing `zh-CN` and `en-US`. If omitted, feedback shows the rule ID and action.
- Empty presets and rules disable checking and report that no protection is active.

Use `/config:safety-guards` to open the normal TUI preset menu; every entry shows the preset state and how many rules it contains, and the `Show effective rules` entry prints the merged rules. `/config:safety-guards show` prints the same list without the menu, and `reset` restores the default preset.

```text
Preset destructive-operations · rules: 4
  filesystem.delete → warn · commands: rm, rmdir (overridden by rules)
  filesystem.format → disabled
  filesystem.ownership → confirm · commands: chown
  shell.fork-bomb → confirm · commandPattern: :\(\)\s*\{
Preset workspace-boundary · rules: 1
  paths.workspace → block · outsideRoots: [.]
Custom rules (rules) · 1
  local.maven → block · commands: mvn, mvnw
```

The list is grouped by preset and marks rules that `rules` overrides or disables. Run `/reload` after saving configuration or preset files.

### Actions

| Action | Behavior |
| --- | --- |
| `warn` | Allow and append a warning to the corresponding tool result, including without a UI. |
| `confirm` | Ask once for the matching rules. Block if prompting is unavailable or the user does not confirm. |
| `block` | Reject without prompting. |

When multiple rules match, priority is `block > confirm > warn`. Feedback includes all matching IDs.

### Matchers

Use exactly one matcher per rule:

| `match` | Meaning |
| --- | --- |
| `{ "commands": ["example-command"] }` | Exact executed command basenames |
| `{ "commandPrefixes": ["mkfs"] }` | Executed command basenames starting with one of the prefixes |
| `{ "commandPattern": ":\\(\\)\\s*\\{" }` | Regular expression over the raw command text; no flags, and quoted text is included |
| `{ "outsideRoots": [".", "../shared"] }` | Explicit paths outside the configured roots |
| `{ "module": "./rules/deploy.mjs" }` | A trusted local matcher module |

`commandPattern` is the escape hatch for command syntax that cannot be expressed with command names. It sees the raw command text, so `echo ':(){ :|:& };:'` matches too; use `module` when a matcher must look at parsed commands and arguments precisely.

The former `detector` matcher was removed because its logic lived in code instead of the configuration. Migration:

| Removed | Replacement |
| --- | --- |
| `{ "detector": "disk-format" }` | `{ "commandPrefixes": ["mkfs"] }` |
| `{ "detector": "fork-bomb" }` | `{ "commandPattern": ":\\(\\)\\s*\\{" }` |
| `{ "detector": "in-place-edit" }` | a `module` matcher that inspects parsed commands and arguments |
| `{ "detector": "home-root" }` | a `module` matcher that inspects parsed commands and arguments |
| `{ "detector": "root-search" }` | a `module` matcher that inspects parsed commands and arguments |

### Directory rules

Relative roots resolve against Pi's current working directory; absolute paths and `~/` are supported. Only listed roots are allowed. The preset uses `.` for the working directory. When `pi-add-dir` is installed, its active directory authorization is also honored; after `session_squash`, the guard restores the authorization from the squashed source branch. Add extra directories and device paths such as `/dev/null` when needed.

Custom matchers can use the exported `findOutOfScopeBashPaths(command, cwd, roots)` helper to supply their own roots.

Names the filesystem cannot represent (containing NUL, or a single component longer than 255 bytes) are not treated as paths, so interpreter program text such as `python3 -c '...'` cannot fail the rule. A candidate whose full path is too long to represent is still judged against the roots instead of failing the rule.

### Custom modules

Module paths resolve against the directory containing `config.json`. A JavaScript ES module must default-export a matcher:

```js
export default ({ commands }) => commands.some(
  ({ name, args }) => name === "example-deploy" && args.includes("--production"),
);
```

The matcher receives a frozen `{ command, cwd, commands: [{ name, args }] }` summary and returns a boolean or `Promise<boolean>`. `RuleContext` and `RuleMatcher` types are exported by the package.

Only enabled modules are loaded. Loading failures, matcher errors, non-boolean results and asynchronous work exceeding five seconds block the operation. Use `/reload` after editing a module.

Modules run with full process permissions. The timeout cannot interrupt synchronous loops or roll back side effects; load only trusted code.

## Limits and errors

The extension checks Pi's `bash` tool, not direct user shell commands, other tools or program-internal operations. It does not cover every dangerous command, simulate every working-directory change or resolve arbitrary variable-generated paths. Path checks handle statically identifiable references and symlinks, not OS-level access control.

A missing config file uses the default preset. Invalid configuration, malformed Bash and enabled-rule failures block Bash until the relevant error is fixed. Configuration changes require `/reload`.

Runtime messages are available in Chinese and English.

## Development

```bash
npm run check
```
