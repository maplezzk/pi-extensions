---
name: configure-pi-session-resources
description: "启用、禁用与排查 pi-session-resources 的 # 文件、URL 和 PR/MR 选择器。Use when configuring session resource references."
---

# 配置 pi-session-resources

这个扩展没有持久化配置文件。选择器每次扩展加载时默认启用，命令只修改当前运行实例：

```text
/config:session-resources
/config:session-resources enable|disable
```

`show|hide` 分别兼容 `enable|disable`，`/session-resources` 是命令别名。不要声称 enable/disable 会跨 `/reload` 持久化。

## 排查

1. 确认当前模式是 TUI；选择器依赖编辑器 UI。
2. 只会从成功的工具结果收集资源；失败调用不会进入列表。
3. 在词边界输入 `#`，继续输入筛选；文件、PR/MR、URL 分 Tab。
4. 自定义工具需要提供可识别的结构化路径或 URL 字段；扩展不会宽泛解析任意正文和 shell 相对路径。

## 验证

先成功调用一次文件工具或产生结构化 URL 的工具，再输入 `#` 观察候选并用 Enter 插入。引用只是普通提示文本，不会自动读取文件。非 TUI 或未实际触发时报告 `NOT_RUN`，不能用命令提示代替选择器证据。
