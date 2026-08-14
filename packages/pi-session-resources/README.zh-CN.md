# pi-session-resources

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的被动会话资源扩展。它从成功的工具活动中收集文件和链接，并在编辑器下方通过可点击的 OSC 8 超链接展示。

[English](./README.md)

## 功能

- 跟踪内置工具和自定义工具读取、修改、检查或打开的文件。
- 跟踪结构化 HTTP(S) URL 字段，以及浏览器、shell、MR/PR 创建工具输出的链接。
- 识别 GitHub Pull Request 与 GitLab Merge Request，并标记 `gh pr create`、`glab mr create` 等创建动作。
- 在 reload、resume、fork 或 `/tree` 导航后，从当前会话分支重建状态；不会向模型上下文写入跟踪条目。
- 将最近资源渲染成 OSC 8 超链接：文件使用 `file://`，网页和 MR/PR 保留原 URL。
- 通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US` 文案。

示例：

```text
会话资源  3 个文件 · 2 个链接
FILE src/index.ts  [改,读]
MR owner/repo#42  [建]
WEB developer.mozilla.org/en-US/docs/Web/API  [开]
```

折叠状态显示最近 4 项，展开状态最多显示 16 项，并提示还有多少较早资源未显示。

## 命令

```text
/session-resources             切换展开/折叠
/session-resources show        显示折叠组件
/session-resources hide        隐藏组件
/session-resources expand      显示更多最近资源
/session-resources collapse    返回紧凑视图
```

## 安装

```bash
pi install npm:pi-session-resources
```

然后在 Pi 中执行 `/reload`。

## 识别方式

扩展监听 Pi 原生 `tool_result` 事件，只记录成功调用。

- 内置 `read`、`write`、`edit`、`grep`、`find`、`ls` 会得到准确的动作标签。
- 自定义工具通过 `path`、`filePath`、`files`、`directory`、`outputPath` 等常见路径字段识别文件。
- 会递归提取结构化 URL/路径字段；shell、浏览器和 MR/PR 创建工具还支持纯文本 URL 输出。
- 浏览器打开和 MR/PR 创建动作会根据工具名与命令文本做保守推断。
- 不会从文件正文和普通描述中宽泛抓取 URL 或路径，避免读取 README 或源码后被无关链接刷满组件。

扩展不会把任意 shell 命令中的相对路径当作 shell 语法解析。内置文件工具、结构化自定义工具路径字段、绝对路径和 URL 可以可靠跟踪；这一限制可以避免把普通命令文本误判成文件。

## OSC 8 兼容性

点击行为取决于终端。Pi fullscreen 模式可以直接打开 OSC 8 链接；普通模式下许多终端需要 Cmd/Ctrl-click。不支持 OSC 8 的终端仍会显示可读标签。

## 隐私与可移植性

本包不发起网络请求，也不启动后台进程。收集状态只保存在内存中，并从当前 Pi 会话分支重建；来源数据本来就存在于工具调用和结果中。显示标签会省略 URL 查询参数，但点击目标保留原始 URL。
