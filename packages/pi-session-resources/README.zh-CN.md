# pi-session-resources

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的被动会话资源扩展。它从成功的工具活动中收集文件和链接，并在编辑器上方通过可点击的 OSC 8 超链接展示。

[English](./README.md)

## 功能

- 跟踪内置工具和自定义工具读取、修改、检查或打开的文件。
- 跟踪结构化 HTTP(S) URL 字段，以及浏览器、shell、MR/PR 创建工具输出的链接。
- 识别 GitHub Pull Request 与 GitLab Merge Request，并标记 `gh pr create`、`glab mr create` 等创建动作。
- 在 reload、resume、fork 或 `/tree` 导航后，从当前会话分支重建状态；不会向模型上下文写入跟踪条目。
- 将最近资源按文件、PR/MR、网页分成三个 Tab，并渲染成 OSC 8 超链接：文件使用 `file://`，网页和 MR/PR 保留原 URL。
- 通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US` 文案。

示例：

```text
────────────────────────────────────────────────────
 ←  [FILE 3]  PR/MR 1  WEB 2  →

 FILE src/index.ts                       [修改,读取]
 FILE docs/session notes.md              [读取]
────────────────────────────────────────────────────
 Ctrl+↑ 浏览 · Ctrl+O 展开
```

组件固定在编辑器上方，一次只显示一个资源类型，避免文件、PR/MR 与网页混排。按 Ctrl+↑ 打开与 `ask_user_question` 风格一致的焦点面板，使用 ←/→ 切换 Tab，使用 ↓ 或 Esc 返回编辑器。

折叠状态显示当前 Tab 最近 4 项，展开状态最多显示 16 项，并提示还有多少较早资源未显示。组件直接跟随 Pi 内置的 `app.tools.expand` 状态，因此 Ctrl+O 同时展开或折叠工具输出与会话资源。用户如果在 `keybindings.json` 中重映射该内置动作，组件也会自动跟随，不会额外注册冲突快捷键。

## 命令

```text
/config:session-resources             打开资源 Tab 浏览面板
/config:session-resources show        显示组件
/config:session-resources hide        隐藏组件
/config:session-resources expand      显示当前 Tab 更多最近资源
/config:session-resources collapse    返回当前 Tab 紧凑视图
```

`/session-resources` 继续作为兼容别名保留。

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

文件目标统一通过 `pathToFileURL()` 生成，结构化 HTTP(S) URL 字段通过 `URL` 归一化，因此空格等不安全目标字符会在写入 OSC 8 前转换为百分号编码。纯文本工具输出仍必须包含语法有效的 URL；如果 URL 本身含空格，应输出 `%20`，因为松散文本解析必须把空白视为正文与 URL 的边界。

## 隐私与可移植性

本包不发起网络请求，也不启动后台进程。收集状态只保存在内存中，并从当前 Pi 会话分支重建；来源数据本来就存在于工具调用和结果中。显示标签会省略 URL 查询参数，但点击目标保留原始 URL。
