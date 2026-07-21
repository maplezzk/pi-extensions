# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的一组可组合扩展。

> English documentation: [README.md](./README.md)

## 包清单

每个包都可以独立安装；具体行为、配置、示例和测试请查看对应包内的 README。

| 包 | 说明 | 文档 |
| --- | --- | --- |
| [`pi-distill`](./packages/pi-distill) | 在所有已启用 object-schema 工具的超长输出占满上下文前进行提炼。 | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-tool-supervisor`](./packages/pi-tool-supervisor) | 根据匹配的项目规则审查 `edit` 和 `write` 变更，并返回结构化结果。 | [English](./packages/pi-tool-supervisor/README.md) · [中文](./packages/pi-tool-supervisor/README.zh-CN.md) |
| [`pi-hud`](./packages/pi-hud) | 在 working spinner 实时显示会话全程耗时，并给出每轮耗时与总耗时小结。 | [English](./packages/pi-hud/README.md) · [中文](./packages/pi-hud/README.zh-CN.md) |
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | 提供共享的语言选择、catalog 加载、插值和 `/pi-language` 命令。 | [English](./packages/pi-extensions-i18n/README.md) · [中文](./packages/pi-extensions-i18n/README.zh-CN.md) |
| [`pi-extensions-tool-display`](./packages/pi-extensions-tool-display) | 提供实际的 Pi 工具展示宿主，以及共享的结果渲染协议和组件工具。 | [English](./packages/pi-extensions-tool-display/README.md) · [中文](./packages/pi-extensions-tool-display/README.zh-CN.md) |

## 一键安装全部扩展

要求：具备兼容扩展 API 的 Pi，以及 Node.js 22 或更高版本。

```bash
pi install git:github.com/maplezzk/pi-extensions
```

仓库根目录本身也是一个 Pi package。它通过 manifest 自动加载所有 `packages/*/index.ts`，因此上面的命令会安装当前全部扩展；以后新增包也会自动包含，不需要再修改根 README 或安装命令。

安装后重新加载 Pi：

```text
/reload
```

如果只想安装单个包，可以使用对应的 npm 包名：

```bash
pi install npm:<package-name>
```

## 配置

扩展使用 Pi 标准 Agent 目录保存配置：

```text
~/.pi/agent/extensions/<package-name>/config.json
```

包级配置示例和详细文档请查看 [`packages/`](./packages)。

## 开发

```bash
npm install
npm run check
```

`check` 会执行 workspace 类型检查、测试，以及可移植性和 i18n 门禁。

## 许可证

[MIT](./LICENSE)
