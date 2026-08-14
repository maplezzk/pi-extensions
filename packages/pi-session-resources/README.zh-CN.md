# pi-session-resources

面向 [Pi 编码助手](https://github.com/earendil-works/pi) 的被动会话资源引用扩展。它从成功的工具活动中收集文件、网页和 PR/MR；在输入框键入 `#` 时，在编辑器上方打开带类型 Tab 的资源选择器。

[English](./README.md)

## 功能

- 跟踪内置工具和自定义工具读取、修改、检查或打开的文件。
- 跟踪结构化 HTTP(S) URL 字段，以及浏览器、shell、MR/PR 创建工具输出的链接。
- 识别 GitHub Pull Request 与 GitLab Merge Request，并标记 `gh pr create`、`glab mr create` 等创建动作。
- 在 reload、resume、fork 或 `/tree` 导航后，从当前会话分支重建状态；不会向模型上下文写入跟踪条目。
- 只在键入 `#` 时显示带边框的资源选择器，不保留常驻面板；文件、PR/MR、网页按 Tab 分开。
- 按资源标签、目标、类型、动作和来源工具模糊筛选最近资源；当前类型 Tab 使用主题选中背景高亮，每行只显示资源标签和动作。
- 候选标签使用 OSC 8 超链接：文件使用 `file://`，网页和 PR/MR 保留原 URL。
- 通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US` 文案。

## 使用

在输入框中的词边界键入 `#`：

```text
┌ 会话资源 ──────────────────────────────────────────────┐
│  FILE 8   PR/MR 2   WEB 3                              │
├────────────────────────────────────────────────────────┤
│ → src/index.ts                               修改 · 读取 │
│   tests/index.test.ts                               修改 │
├────────────────────────────────────────────────────────┤
│ ←/→ 或 Tab/Shift+Tab 切换类型 · ↑/↓ 选择 · Enter 插入 │
└────────────────────────────────────────────────────────┘
请检查 #ind
```

- 继续在 `#` 后输入可实时筛选当前类型。
- 选择器打开时，←/→ 切换资源类型；Tab 切换到下一个类型，Shift+Tab 切换到上一个类型。
- ↑/↓ 循环选择当前类型中的资源。
- Enter 插入当前引用，Esc 关闭选择器并保留已输入文本。
- 当前类型每次最多显示 6 个最近匹配资源。

文件引用使用会话中的显示路径，例如 `#src/index.ts`；含空格的路径会插入为 `#"docs/design notes.md"`。网页和 PR/MR 会插入完整 URL。引用只是普通提示文本，不会额外读取文件或向会话写入隐藏上下文。

候选标签本身是 OSC 8 链接。Pi fullscreen 模式可直接鼠标点击打开；普通模式下许多终端需要 Cmd/Ctrl-click。不支持 OSC 8 的终端仍会显示可读标签。Pi 当前没有公开的扩展组件鼠标命中选择 API，因此鼠标点击用于直接打开目标，候选插入仍使用键盘确认。

## 命令

```text
/config:session-resources             显示 # 引用使用提示
/config:session-resources enable      启用 # 资源选择器
/config:session-resources disable     禁用 # 资源选择器
```

`show`/`hide` 分别兼容 `enable`/`disable`，`/session-resources` 继续作为命令别名保留。

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
- 不会从文件正文和普通描述中宽泛抓取 URL 或路径，避免读取 README 或源码后被无关链接刷满候选。

扩展不会把任意 shell 命令中的相对路径当作 shell 语法解析。内置文件工具、结构化自定义工具路径字段、绝对路径和 URL 可以可靠跟踪；这一限制可以避免把普通命令文本误判成文件。

## 隐私与可移植性

本包不发起网络请求，也不启动后台进程。收集状态只保存在内存中，并从当前 Pi 会话分支重建；来源数据本来就存在于工具调用和结果中。显示标签会省略 URL 查询参数，但插入引用和 OSC 8 点击目标保留原始 URL。
