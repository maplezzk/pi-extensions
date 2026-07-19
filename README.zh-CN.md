# pi-extensions

[![CI](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/maplezzk/pi-extensions/actions/workflows/ci.yml)
[![pi-distill](https://img.shields.io/npm/v/pi-distill?label=pi-distill)](https://www.npmjs.com/package/pi-distill)
[![pi-tool-supervisor](https://img.shields.io/npm/v/pi-tool-supervisor?label=pi-tool-supervisor)](https://www.npmjs.com/package/pi-tool-supervisor)
[![pi-extensions-i18n](https://img.shields.io/npm/v/pi-extensions-i18n?label=pi-extensions-i18n)](https://www.npmjs.com/package/pi-extensions-i18n)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的一组小型、可组合扩展。

项目聚焦于工具调用型编码会话中的三个实际问题：

- 避免超长工具结果无谓占满 Agent 上下文；
- 在 `edit` 和 `write` 完成后，立即对文件变更执行项目规则审查；
- 为独立开发、独立发布的扩展提供一致的中英文运行时底座。

> English documentation: [README.md](./README.md)

## 为什么需要这个项目

Pi 有意保持小巧并通过扩展增强。这种设计适合构建个人工作流，但也意味着一些应用层能力需要由扩展提供：

1. **超长输出会制造上下文压力。** 日志、搜索结果和生成文件的内容，往往远大于 Agent 下一步真正需要的信息。
2. **编辑成功不等于编辑经过审查。** Agent 可以写出语法正确的代码，但仍可能违反项目规则、文件约定或评审要求。
3. **没有公共底座时，各扩展的体验容易分叉。** 每个扩展都不应该重复实现语言选择、catalog 校验、fallback 和配置路径。

`pi-extensions` 用相互独立的 npm 包解决这些问题。每个包都可以单独安装，使用 Pi 原生扩展事件，并避免替换或注册同名内置工具。

## 包清单

| 包 | 做什么 | 解决的问题 | 文档 |
| --- | --- | --- | --- |
| [`pi-distill`](./packages/pi-distill) | 按工具的 `outputPrompt` 提炼 `bash`、`read`、`grep`、`find` 结果；显式要求时保留原文，超大内容写入临时文件。 | 超长工具结果挤占上下文窗口，导致后续推理更慢或不稳定。 | [English](./packages/pi-distill/README.md) · [中文](./packages/pi-distill/README.zh-CN.md) |
| [`pi-tool-supervisor`](./packages/pi-tool-supervisor) | 捕获 `edit` / `write` 前后的文件状态，加载匹配的规则文件，并交给一个或多个配置好的模型执行结构化审查。 | 文件变更虽然成功执行，却可能遗漏项目级安全、架构或风格规则。 | [English](./packages/pi-tool-supervisor/README.md) · [中文](./packages/pi-tool-supervisor/README.zh-CN.md) |
| [`pi-extensions-i18n`](./packages/pi-extensions-i18n) | 提供 `zh-CN` / `en-US` / `auto` 语言选择、catalog 加载与校验、插值，以及 `/pi-language` 命令。 | 独立发布的扩展如果各自实现国际化，容易产生重复代码和不一致的用户文案。 | [English](./packages/pi-extensions-i18n/README.md) · [中文](./packages/pi-extensions-i18n/README.zh-CN.md) |

这些包有意保持独立：只安装需要的能力；依赖它的扩展会自动使用共享的 `pi-extensions-i18n`。

## 安装

要求：具备兼容扩展 API 的 Pi，以及 Node.js 22 或更高版本。

```bash
pi install npm:pi-distill
pi install npm:pi-tool-supervisor
```

如果只需要 `/pi-language`，可以单独安装公共语言包：

```bash
pi install npm:pi-extensions-i18n
```

安装后重新加载 Pi：

```text
/reload
```

第一次使用时可以执行：

```text
/pi-language        # 选择 zh-CN、en-US 或 auto
/pi-distill         # 查看或修改输出提炼配置
/pi-tool-supervisor # 查看或修改文件审查配置
```

## 扩展如何协作

```text
Pi 工具调用
    │
    ├── bash/read/grep/find ──► pi-distill ──► 精简结果 + 审计详情
    │                                             └─► 超大内容写入临时文件
    │
    └── edit/write ───────────► pi-tool-supervisor ─► diff + 规则模型审查
                                                      └─► 将审查结果追加到工具结果

公共运行时：pi-extensions-i18n ──► 语言选择 + 基于 catalog 的用户文案
```

两个行为扩展都使用 Pi 的 `tool_call` 和 `tool_result` 事件。它们不会注册与 Pi 内置工具同名的替代工具，因此可以和其他展示或工作流扩展组合使用。

## 配置

配置采用文件优先，并且不绑定具体机器：

```text
~/.pi/agent/extensions/<package-name>/config.json
```

示例配置：

- [`pi-distill/config.example.json`](./packages/pi-distill/config.example.json)
- [`pi-tool-supervisor/config.example.json`](./packages/pi-tool-supervisor/config.example.json)

每个包的 README 进一步说明环境变量、默认值、兼容行为和失败模式。通常，缺少或无效的可选配置会降级为诊断信息或 noop，不会阻止 Pi 启动。

## 重要边界

- `pi-distill` 是上下文管理扩展，不是 Pi 权限模型的替代品，也不保证摘要包含所有细节。需要完整原文时，请使用严格的 `RAW` 输出提示。
- `pi-tool-supervisor` 是编辑后的审查层：它记录发现并返回给 Agent，不会回滚已经成功的编辑，也不提供操作系统级沙箱。
- 扩展不假定特定用户目录、daemon、终端复用器、通知服务或内网。路径与环境差异会在运行时解析。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run check   # 类型检查 + 测试 + 本机绑定门禁
```

仓库是一个位于 `packages/` 下的小型 npm workspace。每个可发布包都包含自己的入口、测试、配置示例和 README；测试不依赖真实的审查模型或提炼模型。

## 发布

项目使用 [release-please](https://github.com/googleapis/release-please) 自动发布：

1. 使用 [Conventional Commits](https://www.conventionalcommits.org/) 提交变更。
2. CI 检查 Pull Request。
3. Release Please 创建或更新包含版本号和 changelog 的 release PR。
4. 合并 release PR 后，GitHub Actions 使用 OIDC trusted publishing 和 provenance 将发生变化的包发布到 npm。

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请：

- 说明用户问题，以及希望改善的可观察行为；
- 为确定性逻辑补充或更新聚焦测试；
- 用户可见文案统一放在中英文 i18n catalog 中；
- 不引入本机路径、私有服务或未声明的运行时依赖；
- 在本地执行 `npm run check`。

## 许可证

[MIT](./LICENSE)
