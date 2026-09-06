# pi-nested-skills

A Pi extension that discovers skills recursively and provides convenient aliases for nested skill directories.

[中文文档](./README.zh-CN.md)

## Features

- Recursively discovers `SKILL.md` files below one or more configurable skill roots.
- Supports package-style aliases such as `/development:code-reviewer` and `/design:icons.favicon`.
- Keeps Pi's native skill loader responsible for frontmatter validation and skill-body expansion; this package does not duplicate `read` compatibility or skill expansion.
- Extends the native slash-command completion list and preserves built-in Pi command suggestions.
- Provides `/skills` to list discovered aliases.
- Contributes discovered skill files through Pi's `resources_discover` event.
- Uses `pi-extensions-i18n` for all user-visible messages.

## Install

```bash
pi install npm:pi-nested-skills
```

Then run `/reload` in Pi.

## Configure skill roots

Start from [`config.example.json`](./config.example.json) and write it to:

```text
<pi-agent-dir>/extensions/pi-nested-skills/config.json
```

`<pi-agent-dir>` is Pi's configured agent directory, normally `~/.pi/agent`. The `PI_CODING_AGENT_DIR` override is respected by Pi and by this extension.

```json
{
  "skillRoots": [
    "~/shared-skills",
    "skills"
  ]
}
```

A relative root is resolved relative to the Pi agent directory. Each direct child of a root is treated as a skill package, and every visible descendant containing `SKILL.md` is discovered. A root containing `SKILL.md` itself is also accepted as one package.

Environment fallback:

```text
PI_NESTED_SKILLS_ROOTS=~/shared-skills,skills
```

The file configuration takes precedence over the environment, and the environment takes precedence over the default `<pi-agent-dir>/skills` root. `PI_NESTED_SKILLS_DIR` remains a compatibility alias for one root.

## Aliases and native expansion

For a skill at `development/code-reviewer/SKILL.md`, the extension offers:

```text
/development:code-reviewer [arguments]
/skill:development.code-reviewer [arguments]
```

The input hook converts the alias to Pi's native `/skill:<frontmatter-name>` form. Pi then reads the skill body and resolves relative references using its normal skill mechanism. If a frontmatter name is shared by multiple discovered skills, the name-only native form is not guessed; use an unambiguous package/path alias.

Use `/skills` to inspect the complete list. Type `/` to search the merged native and nested-skill completion candidates.

## Portability and privacy

The package does not access credentials, make network requests, start processes, or assume a particular home directory. It follows Pi's agent-directory setting and accepts explicit roots for project or team layouts.

## Requirements

- Node.js 22 or newer.
- Pi `>=0.80.0 <0.81.0`.

## License

MIT — see the repository license.
