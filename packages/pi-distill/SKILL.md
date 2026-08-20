---
name: configure-pi-distill
description: "配置与排查 pi-distill 的模型、压缩阈值、重试、工具开关和审计卡片。Use when configuring pi-distill or diagnosing output distillation."
---

# 配置 pi-distill

## 诊断

1. 定位实际 Pi agent 目录；默认是 `~/.pi/agent`，设置 `PI_CODING_AGENT_DIR` 时使用该目录。
2. 读取 `extensions/pi-distill/config.json`；不存在时从包内 `config.example.json` 建立，不猜字段。
3. 同时检查 `PI_DISTILL_*` 和旧 `PI_BASH_SUMMARY_*` 环境变量。JSON 配置优先；环境变量中同名的新 `PI_DISTILL_*` 优先于旧 `PI_BASH_SUMMARY_*`。

## 修改

优先让用户在 Pi 中运行 `/config:distill`；`/pi-distill` 只是兼容别名。手工配置时只使用包内 `config.example.json` 已声明的字段：

- `model` 留空时使用当前会话模型，否则必须是可用的 `provider/model`；
- `minChars` 控制何时提炼，`maxChars` 与 `maxOutputChars` 控制大结果落盘和返回上限；
- `timeoutRetryCount`、`errorRetryCount` 是额外重试次数；
- `summarizeErrors` 默认 `true`，控制达到 `minChars` 的错误结果是否提炼；环境变量依次为 `PI_DISTILL_SUMMARIZE_ERRORS`、旧 `PI_BASH_SUMMARY_SUMMARIZE_ERRORS`；
- `tools.<name>.enabled` 控制单个工具；`edit`、`write` 默认关闭，其他未配置工具默认开启；
- `render` 只控制展示，不改变提炼语义。

不要把需要完整原文的调用配置成摘要；调用方应传 `outputRequest: "RAW"`。不要为非文本结果启用文本提炼假设。

## 验证

- 用 `/distill:stats` 查看当前会话成功、失败、回退、压缩率和模型消耗。
- 对达到 `minChars` 的文本工具结果观察提炼；再用 `RAW` 确认完整性路径。
- 当前会话无可用模型或模型调用失败时，必须报告原始结果被保留的 fail-open 行为，不能宣称提炼成功。
