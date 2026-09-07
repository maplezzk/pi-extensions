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
| `destructive-operations` | `filesystem.delete` | Executed `rm` or `rmdir` | confirm |
| `destructive-operations` | `filesystem.format` | Executed `mkfs` or `mkfs.*` | confirm |
| `destructive-operations` | `filesystem.ownership` | Executed `chown` | confirm |
| `destructive-operations` | `shell.fork-bomb` | Supported colon-function fork-bomb syntax | confirm |
| `workspace-boundary` (opt-in) | `paths.workspace` | Explicit Bash paths outside `.` | block |

Matching uses parsed commands, including supported wrappers, literal nested shells, substitutions and redirects. `echo 'rm file'` and `git rm` do not count as executing `rm`.

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

Use `/config:safety-guards` to open the normal TUI preset menu, and use `reset` to restore the default preset. Run `/reload` after saving.

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
| `{ "detector": "disk-format" }` | `mkfs` or `mkfs.*` |
| `{ "detector": "fork-bomb" }` | Supported colon-function fork-bomb syntax |
| `{ "detector": "in-place-edit" }` | `sed` in-place flags |
| `{ "detector": "home-root" }` | An unquoted standalone `~` argument |
| `{ "detector": "root-search" }` | A `find` argument equal to `/` |
| `{ "outsideRoots": [".", "../shared"] }` | Explicit paths outside the configured roots |
| `{ "module": "./rules/deploy.mjs" }` | A trusted local matcher module |

### Directory rules

Relative roots resolve against Pi's current working directory; absolute paths and `~/` are supported. Only listed roots are allowed. The preset uses `.` for the working directory. Add extra directories and device paths such as `/dev/null` when needed.

Custom matchers can use the exported `findOutOfScopeBashPaths(command, cwd, roots)` helper to supply their own roots.

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
