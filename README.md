# pi-extensions

A set of extensions for [pi](https://github.com/badlogic/pi-mono), the coding agent.

> 中文说明见下方。[中文](#中文)

## Packages

| Package | Description |
|---|---|
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | Shared i18n catalog loader & translator for pi extensions |
| [`pi-distill`](./packages/pi-distill) | Tool-output distillation with file-first configuration |
| [`pi-tool-supervisor`](./packages/pi-tool-supervisor) | Tool supervisor: edit/write review with interactive configuration |

## Install

Extensions are installed via pi itself:

```bash
pi install npm:pi-distill
pi install npm:pi-tool-supervisor
```

`pi-extensions-i18n` is a shared dependency and is pulled in automatically.

## Configuration

Each extension reads its config from `~/.pi/agent/extensions/<name>/config.json`
(file-first; environment variables as fallback). See each package's
`config.example.json` and README for details.

## Development

```bash
npm install
npm run typecheck
npm test
npm run check   # typecheck + tests + local-binding gate
```

### Contributing

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:` / `fix:` / `chore:` / `docs:` ...); release-please derives version
  bumps and the changelog from them.
- All user-facing copy must be bilingual (zh-CN + en-US) via the
  `pi-extensions-i18n` catalog.
- No machine-local paths, daemons, or private services in source, tests, or docs
  — CI enforces this (`npm run check`).

Releases are automated with release-please: merging the Release PR publishes to
npm with `--provenance` via OIDC trusted publishing.

## License

[MIT](./LICENSE)

---

## 中文

一组 pi 编码助手的扩展包：

| 包 | 说明 |
|---|---|
| `pi-extensions-i18n` | 扩展公共 i18n 底座（catalog 加载 + 翻译器） |
| `pi-distill` | 工具输出提炼（配置优先，环境变量兜底） |
| `pi-tool-supervisor` | 工具监督：文件编辑/写入评审 + 交互式配置 |

安装：`pi install npm:<包名>`；配置文件位于 `~/.pi/agent/extensions/<name>/config.json`。

开发与贡献要求与上文一致：常规式提交、用户文案中英文双语、禁止任何本机绑定（CI 强制）。
