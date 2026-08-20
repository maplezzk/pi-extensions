---
name: configure-pi-interactive-subagents
description: "配置与排查 interactive subagents 的终端复用器、Herdr split/tab 和状态面板。Use when configuring subagent mux behavior."
---

# 配置 pi-interactive-subagents

## 诊断

读取实际 Pi agent 目录下的 `extensions/pi-interactive-subagents/config.json`：`mux` 保存后端偏好，`herdrMode` 保存 `split|tab`。状态面板的 `status.enabled` 由安装包根目录的 `config.json` 读取；不存在时读取同目录 `config.json.example`。状态行数当前固定为 4，不是配置项。

环境变量优先级：`PI_TERMINAL_MUX` > `PI_SUBAGENT_MUX` > 持久化 `mux` > `auto`；`PI_SUBAGENT_HERDR_MODE` > 持久化 `herdrMode` > `split`。

## 修改

优先运行：

```text
/config:subagent auto|muxy|cmux|tmux|zellij|wezterm|herdr [split|tab]|otty|orca
```

不带参数时使用交互选择。`/subagent-config`、`/pi-subagent-config` 是兼容别名。选择会立即写入用户配置并应用；环境变量仍可覆盖。

不要把未支持的后端写入配置。修改状态配置时只使用 `status.enabled`；`status.lineLimit` 等未知字段会显式失败，无效 JSON 也不会静默回退。

## 验证

先用 `subagents_list` 确认扩展工具已加载，再启动一个最小 `subagent`，观察对应 pane/tab 与状态 widget。终端后端不可用时必须报告失败；不要静默声称已回退到目标后端。真实启动会创建子进程和终端 surface，执行前遵守当前任务的 E2E 授权边界。
