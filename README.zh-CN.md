# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的一组可组合扩展。

> English documentation: [README.md](./README.md)

仓库中的扩展主要解决工具调用型编码流程中的常见问题：

- 在超长工具结果占满上下文前进行提炼；
- 根据项目规则审查 `edit` 和 `write` 产生的文件变更；
- 为独立发布的扩展提供一致的中英文运行时文案。

每个扩展都是 `packages/` 下的独立包，具体行为、配置、示例和测试请查看对应包内的 README。

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
