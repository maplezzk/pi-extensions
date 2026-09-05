# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的一组可组合扩展。

> English documentation: [README.md](./README.md)

## 包清单

每个包都可以独立安装；具体行为、配置、示例和测试请查看对应包内的 README。每个扩展包也会发布一个 `SKILL.md`，由 Pi 加载后引导 Agent 完成配置与验证。

| 包 | 说明 | 文档 |
| --- | --- | --- |
| [`pi-nested-skills`](./packages/pi-nested-skills) | 从配置目录发现嵌套技能，提供别名调用和补全。 | [English](./packages/pi-nested-skills/README.md) · [中文](./packages/pi-nested-skills/README.zh-CN.md) |
| [`pi-distill`](./packages/pi-distill) | 在所有已启用 object-schema 工具的超长输出占满上下文前进行提炼。 | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-tool-supervisor`](./packages/pi-tool-supervisor) | 根据匹配规则在工具执行前后进行审查，并对 `edit`、`write` 使用真实 diff。 | [English](./packages/pi-tool-supervisor/README.md) · [中文](./packages/pi-tool-supervisor/README.zh-CN.md) |
| [`pi-metrics`](./packages/pi-metrics) | 在 working spinner 实时显示会话全程耗时，并给出每轮耗时与总耗时小结。 | [English](./packages/pi-metrics/README.md) · [中文](./packages/pi-metrics/README.zh-CN.md) |
| [`pi-models-discovery`](./packages/pi-models-discovery) | 自动发现 models.json 中标记 `discoverModels` 的 provider 的模型列表，启动走持久化缓存，并提供手动刷新命令。 | [English](./packages/pi-models-discovery/README.md) · [中文](./packages/pi-models-discovery/README.zh-CN.md) |
| [`pi-session-tools`](./packages/pi-session-tools) | 缓存 bash `grep`/`tail`/`head` 管道过滤前的完整输出，并提供 `session_log` / `session_squash` 对话压缩（主 agent 生成交接摘要）。 | [English](./packages/pi-session-tools/README.md) · [中文](./packages/pi-session-tools/README.zh-CN.md) |
| [`pi-session-resources`](./packages/pi-session-resources) | 从成功工具活动中收集文件、浏览器 URL 和 PR/MR 链接，并通过编辑器上方可点击、可切换类型的 `#` 资源选择器进行引用。 | [English](./packages/pi-session-resources/README.md) · [中文](./packages/pi-session-resources/README.zh-CN.md) |
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | 提供共享的语言选择、catalog 加载、插值和 `/config:language` 命令。 | [English](./packages/pi-extensions-i18n/README.md) · [中文](./packages/pi-extensions-i18n/README.zh-CN.md) |
| [`pi-extensions-tool-display`](./packages/pi-extensions-tool-display) | 提供实际的 Pi 工具展示宿主，以及共享的结果渲染协议和组件工具。 | [English](./packages/pi-extensions-tool-display/README.md) · [中文](./packages/pi-extensions-tool-display/README.zh-CN.md) |
| [`@maplezzk/pi-dynamic-workflows`](./packages/pi-dynamic-workflows) | Claude-Code 风格的动态 workflow 编排，支持 `meta`/`phase()`/`agent()`/`parallel()`/`pipeline()` 原语，通过 `/config:workflow` 配置。Fork 自 michaelliv/pi-dynamic-workflows。 | [English](./packages/pi-dynamic-workflows/README.md) · [中文](./packages/pi-dynamic-workflows/README.zh-CN.md) |
| [`@maplezzk/pi-interactive-subagents`](./packages/pi-interactive-subagents) | 终端复用器分屏中的非阻塞交互式子 agent，带实时状态 widget、`/plan` 与 `/iterate` 工作流。Fork 自 HazAT/pi-interactive-subagents。 | [English](./packages/pi-interactive-subagents/README.md) · [中文](./packages/pi-interactive-subagents/README.zh-CN.md) |

插件管理类斜杠命令统一采用 `/config:<功能>[-动作]` 命名。改名前的命令会继续作为兼容别名保留；`/plan`、`/iterate`、`/subagent` 是刻意保留的高频工作流快捷命令。

## 一键安装全部扩展

要求：具备兼容扩展 API 的 Pi，以及 Node.js 22 或更高版本。

```bash
pi install git:github.com/maplezzk/pi-extensions
```

仓库根目录本身也是一个 Pi package。它通过 manifest 加载 `packages/*/index.ts` 下的扩展入口，并排除 `pi-terminal-mux` 等纯库包，因此上面的命令会安装当前全部扩展，但不会误把共享库作为扩展加载。

安装后重新加载 Pi：

```text
/reload
```

如果只想安装单个包，可以使用对应的 npm 包名：

```bash
pi install npm:<package-name>
```

## 配置

多数可配置扩展会在 Pi agent 目录下保存状态；具体路径、命令、环境变量优先级和验证方式以各包为准。

Pi 会加载已安装扩展包内的 `SKILL.md`，让 Agent 按包级流程完成配置。配置示例和详细文档请查看 [`packages/`](./packages)。

## 开发

```bash
npm install
npm run check
```

`check` 会执行 workspace 类型检查、测试，以及可移植性和 i18n 门禁。

## 许可证

[MIT](./LICENSE)
