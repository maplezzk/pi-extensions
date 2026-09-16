# pi-safety-guards

Bash safety rules for Pi: rules live in the configuration file, with per-rule actions, messages and custom matchers.

[中文文档](./README.zh-CN.md)

## Install

```bash
pi install npm:pi-safety-guards
```

Run `/reload` after installation or configuration changes.

## Default rules

On the first run, if the configuration file does not exist yet, the extension writes these four rules to `<pi-agent-dir>/extensions/pi-safety-guards/config.json` and reads only that file afterwards. No built-in rules are hidden in code: editing the file is editing the behavior.

| Rule ID | Match | Action |
| --- | --- | --- |
| `filesystem.delete` | `commands: rm, rmdir` | confirm |
| `filesystem.format` | `commandPrefixes: mkfs` | confirm |
| `filesystem.ownership` | `commands: chown` | confirm |
| `shell.fork-bomb` | `commandPattern: :\(\)\s*\{` | confirm |

These four rules are the former `destructive-operations` preset; the same JSON is in [config.example.json](./config.example.json) and can be copied as a whole. The former `workspace-boundary` preset (block paths outside the workspace) is now written like this:

```json
{ "id": "paths.workspace", "action": "block", "match": { "outsideRoots": ["."] } }
```

Matching uses parsed commands, including supported wrappers, literal nested shells, substitutions and redirects. `echo 'rm file'` and `git rm` do not count as executing `rm`; `commandPattern` is the exception and sees the raw command text.

## Configuration

File: `<pi-agent-dir>/extensions/pi-safety-guards/config.json`. The agent directory respects `PI_CODING_AGENT_DIR`. Only `rules` is accepted at the top level.

```json
{
  "rules": [
    { "id": "filesystem.delete", "action": "confirm", "match": { "commands": ["rm", "rmdir"] } },
    {
      "id": "project.build",
      "action": "block",
      "match": { "commands": ["mvn"] },
      "message": { "zh-CN": "禁止直接运行 Maven。", "en-US": "Direct Maven execution is blocked." }
    },
    { "id": "paths.workspace", "enabled": false, "action": "block", "match": { "outsideRoots": ["."] } }
  ]
}
```

See also [config.example.json](./config.example.json) and [custom-rules.json](./examples/custom-rules.json).

- `rules`: the rule list, and it may be empty; an empty list means no protection at all and is reported at startup.
- Every rule needs `id`, `action` and `match`; an `id`-only entry no longer does anything (presets were removed).
- `enabled`: optional boolean; `false` keeps a rule in the file but stops executing it. A disabled rule still needs a complete `id`, `action` and `match`.
- IDs must be unique within the list. Unknown fields are rejected instead of silently ignored.
- `message`: optional non-empty text or an object containing `zh-CN` and `en-US`. If omitted, feedback shows the rule ID and action.

`/config:safety-guards` (same as `/config:safety-guards show`) prints the configuration file path and the effective rules. It opens no menu and never writes files:

```text
Configuration file: <pi-agent-dir>/extensions/pi-safety-guards/config.json
  filesystem.delete → confirm · commands: rm, rmdir
  project.build → block · commands: mvn
  paths.workspace → disabled
```

Disabled rules are marked `disabled`. Run `/reload` after saving the file.

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

Relative roots resolve against Pi's current working directory; absolute paths and `~/` are supported. Only listed roots are allowed, and `["."]` means the working directory. When `pi-add-dir` is installed, its active directory authorization is also honored; after `session_squash`, the guard restores the authorization from the squashed source branch. Add extra directories and device paths such as `/dev/null` when needed.

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

A missing config file means no rules; invalid configuration, malformed Bash and enabled-rule failures block Bash until the relevant error is fixed. Configuration changes require `/reload`.

Runtime messages are available in Chinese and English.

## Development

```bash
npm run check
```
