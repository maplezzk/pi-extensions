---
name: configure-pi-extensions-tool-display
description: "配置与排查 Pi 工具展示宿主、内建/自定义工具 override、输出模式和 diff 视图。Use when changing pi-extensions-tool-display rendering."
---

# 配置 pi-extensions-tool-display

## 诊断

读取实际 Pi agent 目录下的 `extensions/pi-tool-display/config.json`。注意目录名是 `pi-tool-display`，不是 npm 包名。以包内 `config.example.json` 和当前源码支持的字段为准。

确认没有同时加载另一份工具展示宿主；`pi-distill` 与 `pi-tool-supervisor` 已会加载这个共享宿主，通常无需重复安装。

## 修改

优先运行 `/config:tool-display`；`/tool-display`、`/pi-tool-display` 是兼容别名。按目标最小修改：

- `registerToolOverrides` 控制 `read/grep/find/ls/bash/edit/write` 的展示所有权；
- `customToolOverrides.<tool>` 使用 `enabled`、`kind`、`outputMode`；
- `readOutputMode`、`searchOutputMode`、`mcpOutputMode`、`bashOutputMode` 控制输出展示；
- `diffViewMode`、`diffIndicatorMode`、折叠行数和换行字段只影响 diff UI；
- `enabled: false` 关闭宿主展示。

不要把展示开关解释为禁用工具，也不要让多个宿主同时注册同一内建 override。

## 验证

分别调用一个受影响的内建或自定义工具，观察折叠、预览、diff 或输出模式。若消费者审计卡片未出现，先确认宿主只加载一次，再确认消费者 middleware 已注册；不能用配置文件可解析代替真实 UI 证据。
