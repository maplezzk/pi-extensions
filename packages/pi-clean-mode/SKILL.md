---
name: configure-pi-clean-mode
description: 配置与排查 pi-clean-mode 的折叠单位、耗时头、自动展开与快捷键。Use when configuring clean mode or diagnosing collapsed transcript behaviour.
---

# 配置与排查 pi-clean-mode

`pi-clean-mode` 把一轮 agent 运行的工作过程折叠成一行耗时头，只留最终答案。折叠不是靠重新注册工具，而是替换 Pi 导出的对话组件原型方法。

## 交互与配置

路径：`<pi agent 目录>/extensions/pi-clean-mode/config.json`。

| 配置项 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后所有补丁放行原始渲染 |
| `autoExpandWhileRunning` | `true` | 执行中展开、运行结束后收起 |
| `showRunHeader` | `true` | 折叠时在最终答案上方显示 `用时 …` |
| `showExpandHint` | `true` | 折叠头末尾附带展开提示 |

改配置：`/config:clean-mode showRunHeader=off`，或直接编辑文件后重启会话。

切换折叠：`f2` 或 `/clean`；全屏模式（`pi --tui-mode fullscreen`）下还可以直接鼠标点击耗时头。

## 行为排查

| 现象 | 检查点 |
|---|---|
| 折叠后什么都没了 | `autoExpandWhileRunning` 是否被关掉，导致运行中也不显示；确认 `agent_settled` 能正常触发 |
| 运行结束后没有自动收起 | 本轮是否手动切换过 —— 手动切换会压制本轮自动收起，这是预期行为；否则检查 `agent_settled` 是否触发、TUI 句柄是否取得 |
| 耗时头上方太挤或下方空太多 | 耗时头子组件应输出「空行 + 耗时头」两行；下方间距由内容容器自带的 Spacer 提供，不要再加尾随空行 |
| 鼠标点不动 | 是否全屏模式；常规模式终端自己接管鼠标，Pi 收不到点击 |
| 折叠后最终答案不见了 | 该消息是否被判定成「带 tool call」。`stopReason === "length"` 的截断回复可能含未完成的 tool call，从而被当作工作过程隐藏 |
| 耗时头不显示 | `showRunHeader` 是否为 on；`runDurationMs` 是否为空（缺少 `agent_start` 时无耗时） |
| 快捷键无反应 | `f2` 是否被用户 keybindings 占用 |
| 折叠完全无效 | Pi 版本是否仍导出 `AssistantMessageComponent` / `ToolExecutionComponent` |

## 边界

- 折叠单位是 `agent_start` → `agent_settled` 的整次运行，不是单个 LLM turn。
- 耗时头在折叠态与展开态都显示，这样两个方向都有可点击的鼠标目标。
- 原型补丁在 reload / shutdown 时还原；若安装后原型被其它扩展替换，本扩展不会顶掉对方的实现。
- 与重新注册工具类的扩展（例如 `pi-extensions-tool-display`）不冲突：本扩展不调用 `pi.registerTool`。
