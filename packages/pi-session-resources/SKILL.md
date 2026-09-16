---
name: configure-pi-session-resources
description: "启用、禁用与排查 pi-session-resources 的 # 文件、URL 和 PR/MR 选择器。Use when configuring session resource references."
---

# 配置 pi-session-resources

配置文件为 `<Pi agent 目录>/extensions/pi-session-resources/config.json`，默认启用选择器。可以使用 `/config:session-resources enable|disable` 修改并持久化配置：

```text
/config:session-resources
/config:session-resources enable|disable
```

`show|hide` 分别兼容 `enable|disable`，`/session-resources` 是命令别名。修改配置文件后执行 `/reload`。

## 排查

1. 确认当前模式是 TUI；选择器依赖编辑器 UI。
2. 只会从成功的工具结果收集资源；失败调用不会进入列表。
3. 在词边界输入 `#`，继续输入筛选；文件、PR/MR、URL 分 Tab。
4. 自定义工具需要提供可识别的结构化路径或 URL 字段；扩展不会宽泛解析任意正文和 shell 相对路径。
5. 输入框上方的「查看资源」按钮只在 Pi fullscreen 模式（`--tui-mode fullscreen` 或 settings 的 `tuiMode: fullscreen`）出现：普通模式终端不会把鼠标事件交给 Pi，扩展拿不到点击。按钮还需要支持组件鼠标 API 的 Pi 版本（`@earendil-works/pi-tui` 0.85 及以上）。
6. 资源行为空时按钮不渲染；点击按钮打开的面板没有 `#` 前缀，此时输入字符会回到输入框而不是筛选。

## 验证

先成功调用一次文件工具或产生结构化 URL 的工具，再输入 `#` 观察候选并用 Enter 插入。引用只是普通提示文本，不会自动读取文件。fullscreen 鼠标路径需要真实终端驱动：确认按钮出现、点击计数块直接打开对应 Tab、点击后展开面板、点击 Tab 切换类型、点击右上角 `✕` 关闭面板、点击资源行由 Pi 自身打开链接；候选超过单屏时用 ↑/↓ 滚动并看到提示行右侧的位置计数。非 TUI、非 fullscreen 或未实际触发时报告 `NOT_RUN`，不能用命令提示代替选择器证据。
