# pi-session-tools

Pi 会话辅助扩展包，默认加载 bash 管道输出缓存和对话压缩。

[English](./README.md)

## 安装

```bash
pi install npm:pi-session-tools
```

随后执行 `/reload`。

## 功能

- 当 bash 管道中使用 `grep`、`tail` 或 `head` 过滤输出时，将过滤前的完整输出写入系统临时目录下的 `pi-pipe-cache/`，并在结果中给出路径，可以直接对缓存文件重新过滤而不用重跑命令。
- 提供 `session_log`：按原索引列出 active branch 的用户消息和可选起点。已经作为压缩起点保留的 user anchor 仍可重复选择，从而把上次快照之后新增的自动续接内容折叠进下一份快照；原分支仍可通过 `/tree` 找回。
- 提供 `session_squash`：接收总结和接续模式，并把从指定消息开始的对话压缩为该总结。原对话不删，可通过 Pi 的 `/tree` 找回。
- 总结由主 agent 基于完整对话上下文生成，并直接随 `session_squash` 调用提交（不发独立 LLM 请求，也没有 finalize 步骤）；被压缩范围内读/改过的文件清单会自动附上。

调用 `session_squash` 前先调用 `session_log`，用已完成回合的编号作为 `from`，并把完整任务状态快照传给 `session_squash`。选中的 user turn 会作为新分支锚点保留，以维持后续 user turn 索引稳定；任务状态快照作为被压缩后缀的权威状态。该锚点会继续出现在后续 `session_log` 中，可重复选择，从而让新快照吸收“上次快照之后、下一条 user turn 之前”的自动续接内容；也可以从更早索引重新压缩更大范围。

任务或阶段到达安全停点时都可以压缩，例如阶段完成、验证完成、关键决策落定或准备进入下一阶段；无需等整个任务交付。摘要重点说明被压缩范围内做了什么、作用对象、最终结果和验证，并明确当前准确停点、剩余事项、制品状态和下一步。已完成工作不得重复列入剩余事项；必要时使用 `VERIFIED`、`INFERRED`、`UNKNOWN`、`NOT VERIFIED` 或 `BLOCKED`。摘要只保留有效任务状态，不记录上下文阈值、`session_log`、`session_squash` 或会话切换等维护过程。仍有可立即执行的工作时使用 `continuation: "auto"`；当前任务已完成且下一步必须等待用户新输入时使用 `continuation: "next-user"`，只保存快照而不额外触发模型回合。若摘要与 workspace、Git 或测试证据冲突，以实际证据为准并报告冲突。

## 上下文阈值提示

对话变长跨过阈值时（默认 150k / 200k / 250k / 300k tokens），会向主 agent 显示“已用 tokens / context window（占比）”，并提醒它在最近的任务或阶段安全停点压缩，不必等待整个任务结束。提醒不强制；仅在模型正常停止时触发，用户手动终止或提供方异常不会触发。可配置：

```jsonc
// ~/.pi/agent/extensions/pi-session-tools/config.json
{ "squashContextThresholds": ["150k", "200k", "75%"] }   // k、数字与百分比可混合
```

也可用交互式命令 `/config:session-tools`（别名 `/pi-session-tools`）配置。

也支持环境变量 `PI_SESSION_TOOLS_SQUASH_THRESHOLDS`（逗号分隔，如 `150k,75%`）。

## 强制压缩

强制压缩默认关闭。在同一个配置文件中设置 `0` 到 `1` 的 JSON 数字，表示模型上下文窗口占比：

```jsonc
{
  "squashContextThresholds": ["150k", "200k", "75%"],
  "forceSquashContextThreshold": 0.9 // 表示上下文窗口的 90%；null 表示关闭
}
```

也可执行 `/config:session-tools force 0.9`；使用 `/config:session-tools force off` 关闭。强制压缩不再接受 `"90%"` 这类百分比字符串。

每个 assistant 工具批执行完成后，扩展都会检查上下文用量。达到强制阈值时，会在下一次模型调用前中止当前 agent loop，保存原活动工具集合，并只开放 `session_log` 和 `session_squash`；其他工具调用会被阻止。如果 agent 停止但没有压缩，扩展会自动再次触发强制回合，限制持续到 `session_squash` 成功。成功后恢复原工具并基于摘要继续。已经开始执行的工具会先完成，避免文件修改停在半完成状态。

## 本地化

全部用户可见文案通过 `pi-extensions-i18n` 提供中英双语（zh-CN / en-US）。
