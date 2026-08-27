---
name: configure-pi-session-tools
description: "配置与排查 session squash 提醒阈值、强制压缩比例和 bash 管道缓存。Use when configuring pi-session-tools context management."
---

# 配置 pi-session-tools

## 诊断

读取实际 Pi agent 目录下的 `extensions/pi-session-tools/config.json`，并检查 `PI_SESSION_TOOLS_SQUASH_THRESHOLDS`。配置字段：

- `squashContextThresholds`：数字、`150k` 或 `75%` 可混合；
- `forceSquashContextThreshold`：`0` 到 `1` 的 JSON 数字，`null` 表示关闭。

环境变量只配置提醒阈值，不配置强制比例。

## 修改

优先使用 `/config:session-tools`；`/pi-session-tools` 是兼容别名。强制模式使用 `/config:session-tools force 0.9`，关闭使用 `force off`。不要给强制比例写 `"90%"` 字符串。

提醒阈值只在正常停止且跨过阈值时提示。强制阈值达到后只开放 `session_log` 与 `session_squash`，直到压缩成功；不要绕过或静默关闭。

## 验证

- 配置后回读 JSON，确认类型和值未被归一化成意外形式。
- 压缩时先调用 `session_log`，再把完整任务状态快照直接传给 `session_squash`；没有独立 finalize 步骤。快照首行必须是 `# Handoff: <topic>`，并按固定顺序包含 `Timeline of user and agent work`、`Current focus`（其中包含 `### Background and problem origin`）、`Errors and resolutions`、`Code and artifact state`、`Environment and repository state`、`Completed work and decisions`、`Active issues and next actions`、`Important context and boundaries` 和 `Suggested skills`；时间线逐条区分 `User` 与 `Agent`。如果主 agent 漏写时间线，扩展会自动从被压缩分支补一份紧凑事实时间线；缺少其他必需章节或顺序错误则拒绝压缩。任务或阶段到达安全停点即可压缩，无需等整个任务结束。已作为压缩起点保留的 user anchor 会继续返回；若上次快照后、下一条 user turn 前产生了自动续接内容，应复用该锚点重新压缩。用户纠正优先于 Agent 推断；未证实内容标记 `INFERRED`、`UNKNOWN`、`NOT VERIFIED` 或 `BLOCKED`；不要记录压缩、阈值或会话切换过程，也不要让已完成工作再次进入下一步。每次压缩都必须显式选择接续模式：仍有可立即执行的工作时设置 `continuation: "auto"`；任务已完成或 Resume 依赖用户尚未确认的信息时设置 `continuation: "next-user"`。持久化层仍使用 `custom_message` 以保留 UI 和 `/tree` 能力，但下一轮模型上下文会把它呈现为原生 compaction summary；接手 Agent 必须把它当作当前任务状态交接，而不是新的用户需求。
- bash 管道缓存只在 `grep`、`tail`、`head` 管道场景产生临时文件指针。未实际达到上下文阈值时，强制行为报告 `NOT_RUN`。
