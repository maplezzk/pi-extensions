# pi-auto-goal

Pi 的停止守卫：agent 停下来时，用第二个模型判断这次停止是否属于「擅自早停」，并用你的语气让 agent 继续干活。

[English](./README.md)

## 它做什么

一个多步任务只做了一半，agent 却改完一个文件、汇报了进度就结束——这在 Pi 里很常见。`pi-auto-goal` 监听 `agent_settled`（Pi 确定不会自己继续的时刻），然后用第二个模型只回答一个问题：**此刻停下算合理，还是还有活没干完？**

当结论是「还有活没干完」且置信度足够高时，扩展会以用户语气发一条严厉消息，点明缺口并要求 agent 继续。否则保持安静，本轮正常结束。

## 安装与使用

```bash
pi install npm:pi-auto-goal
```

安装或改配置后执行 `/reload`。

除非 `enabled` 为 false，每次完全停止都会判定一次，所以一句普通问答也会多花一次判定调用。判定输入包括：

- **用户请求**：当前分支上最后一条真实用户输入。本扩展注入的催促消息会被跳过，因此连续干预时判定的始终是你最初的请求。
- **最后输出**：agent 本轮最后一段文本输出。
- **工具轨迹**：该用户输入之后发生的工具调用，每条压缩成一行。

判定模型看不到你其它的会话分支。

## 安全边界

- **干预次数有上限**：`maxAutoContinues`（默认 `2`）限制同一条用户请求的自动干预次数；你自己发新消息会重置计数。到达上限只提示一次，之后不再干预。
- **不打断你的输入**：判定期间如果你开了新一轮、有排队消息，或会话分支已经变化，判定结果直接丢弃。
- **判定偏保守**：内置判定提示词把证据不足、礼貌收尾、只做分析都视为未完成，并在证据有歧义时判「可以停」。
- **失败必须报告**：判定、鉴权、超时和发送失败都会在 UI 里报错，判定失败绝不会被当成「可以停止」。

## 配置

文件：`<pi-agent-dir>/extensions/pi-auto-goal/config.json`，遵守 `PI_CODING_AGENT_DIR`。可从 [`config.example.json`](./config.example.json) 开始。

```json
{
  "enabled": true,
  "model": "",
  "maxAutoContinues": 2,
  "confidenceThreshold": 0.6,
  "timeoutSeconds": 30,
  "includeToolTrace": true,
  "maxUserRequestChars": 2000,
  "maxFinalOutputChars": 4000,
  "maxToolTraceEntries": 20,
  "notifyOnStopDecision": false,
  "continueMessageTemplate": "",
  "forcedDecision": "auto"
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后不产生任何判定调用。 |
| `model` | `""` | 判定模型，格式 `provider/modelId`；留空则复用当前会话模型。 |
| `maxAutoContinues` | `2` | 同一条用户请求允许的自动干预次数；`0` 表示不限制。 |
| `confidenceThreshold` | `0.6` | 触发干预所需的最低置信度。 |
| `timeoutSeconds` | `30` | 判定请求超时；超时只报告，不当成可以停止。 |
| `includeToolTrace` | `true` | 是否把本轮工具调用轨迹交给判定模型。 |
| `maxUserRequestChars` | `2000` | 用户请求截断长度。 |
| `maxFinalOutputChars` | `4000` | agent 最后输出截断长度。 |
| `maxToolTraceEntries` | `20` | 工具轨迹最大条数。 |
| `notifyOnStopDecision` | `false` | 判定为「可以停止」时是否也提示。 |
| `continueMessageTemplate` | `""` | 覆盖内置催促文案，支持 `{reason}` 占位。 |
| `forcedDecision` | `"auto"` | 受控实验开关：`auto`（正常判定）、`continue`（强制判定为提前停止）、`stop`（强制判定为可停止）。 |

未知字段与非法值会明确报错，不会被静默忽略。

### 命令

- `/config:auto-goal` — TUI 配置菜单（别名：`/auto-goal`、`/pi-auto-goal-config`）。
- `/config:auto-goal enable|disable|status|reset` — 非交互式写法；`status` 显示生效配置与本会话已干预次数。

## 开发

```bash
cd packages/pi-auto-goal
npm run typecheck
npm test
npm run check
```

测试是确定性的：判定调用可以注入替身，不需要 API key 或真实模型。
