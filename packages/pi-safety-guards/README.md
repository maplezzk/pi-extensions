# pi-safety-guards

Deterministic safety guards for the [Pi coding agent](https://pi.dev). The package keeps three independent guards: dangerous Bash commands, Bash path scope, and direct Maven invocation.

[中文文档](./README.zh-CN.md)

## Install

```bash
pi install npm:pi-safety-guards
```

Then reload Pi:

```text
/reload
```

The package loads the dangerous-command, Bash-directory-scope, and Maven guards through its root extension entry. Notifications are intentionally not included; install `pi-notifications` separately if you want desktop notifications.

## Default behavior

- Blocks actual `rm` and `rmdir` commands and recommends the recoverable `trash` command. Subcommands such as `git rm` and `npm rm` are not matched.
- Blocks `sed -i` and recommends Pi's `edit` tool.
- Blocks direct searches of `~` and `find /`, which are too broad for routine agent work.
- Allows explicit local paths under the current directory, directories recorded by `add_directory`, the standard skills directories, `/tmp`, and `/var`. It resolves nested shells, wrappers, redirects, and symlinks before checking scope. A single script directly under a skills directory may receive an explicit project path; paths in a command chain are still checked normally.
- Requires confirmation in TUI mode for `chown`, `mkfs`, and fork bombs. Non-interactive modes block these commands instead.
- Blocks direct Maven commands, including wrappers and literal nested-shell invocations. The message recommends the configured Java build skill.
- Incomplete Bash parses are blocked rather than guessed.

## Configuration

Guard switches and the Maven message are configured in:

```text
<pi-agent-dir>/extensions/pi-safety-guards/config.json
```

Start from [`config.example.json`](./config.example.json):

```json
{
  "dangerCommands": true,
  "bashDirectoryScope": true,
  "maven": true,
  "javaSkill": "java-build"
}
```

Configuration file precedence is higher than `PI_JAVA_SKILL`, which is higher than the built-in `java-build` default. A missing file uses defaults. Invalid configuration is reported and blocks Bash until the file is fixed and Pi is reloaded. Set any guard switch to `false` to skip registering its hook. Changes require `/reload`. `PI_CODING_AGENT_DIR` controls the Pi agent directory in the usual Pi way.

## Package boundaries

The dangerous-command and Bash path guards are deterministic checks. They do not replace Pi's own permissions or sandboxing. This package does not include Java source-rule reminders, forced Maven verification, or notification behavior.

## Requirements

- Node.js 22 or newer.
- Pi 0.80.x with the compatible extension API.

## License

[MIT](../../LICENSE)
