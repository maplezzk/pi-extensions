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

安装后执行 `/reload`；用 `/config:auto-goal` 改的配置立即生效，手动改配置文件才需要 `/reload`。

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
- **只在持续会话中生效**：TUI 与 RPC 模式下才会判定；print/json 模式在 agent 停止后就收尾，催促不可能执行，因此直接跳过。

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
  "showVerdictNotice": true,
  "judgeMaxTokens": 2000,
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
| `notifyOnStopDecision` | `false` | 已废弃：每轮只发一条结论块，这个开关不再起作用（保留字段以免旧配置报错）。 |
| `showVerdictNotice` | `true` | 把最近一次判定结论写进会话区（落在消息下方，带底色的消息块；细节按 Ctrl+O 展开）。 |
| `judgeMaxTokens` | `2000` | 单次判定调用的输出 token 上限，同时会被收敛到模型自身的输出上限。 |
| `continueMessageTemplate` | `""` | 覆盖内置催促文案，支持 `{reason}` 占位。 |
| `forcedDecision` | `"auto"` | 受控实验开关：`auto`（正常判定）、`continue`（强制判定为提前停止）、`stop`（强制判定为可停止）。 |

未知字段与非法值会明确报错，不会被静默忽略。

### 怎么知道它到底有没有触发

每轮结束后，会话区里（消息下方）会出现**一条**带底色的 `[auto-goal]` 消息块，内容是判定结论（由 `showVerdictNotice` 控制，默认开）：

| 结论行 | 颜色 | 含义 |
| --- | --- | --- |
| `⚖ 停止合理 0.92` | 绿 | 判定为正常结束，没有干预。 |
| `⚖ 已催促 1/2` | 黄 | 判定为提前停止，已自动发催促。 |
| `⚖ 已达上限 2/2` | 灰 | 本轮干预次数用尽，不再干预。 |
| `⚖ 已打断，未判定` | 灰 | 你按 Esc 打断了这一轮，判定主动让路。 |
| `⚖ 本轮未正常结束，未判定` | 灰 | 这一轮以失败或残缺结束（不是 agent 自己停下）。 |
| `⚖ 判定失败` | 红 | 判定调用失败。 |

正文只占一行；判定理由、已发送的催促文本、失败原因、结束原因等细节收在展开里：**按 `Ctrl+O`** 展开工具输出时会一起展开，平时不占地方。

判定结论不进 LLM 上下文，也不会写到页脚状态栏；它是本包写进会话的一条本地条目，重新打开会话时仍会照原样显示。

### 什么轮次会被判定

只判定「正常跑完」的轮次：最后一条 assistant 消息的结束原因是 `stop`（agent 自己结束本轮）或 `length`（输出被长度上限截断）。

用户按 Esc 打断时，结束原因是 `aborted` 或 `error`、内容为空——这是你的决定，不是 agent 的停止决定。以前这种轮次也会被当成「提前停止」去催，结果是刚按完 Esc 就被自动复活，看起来像 Esc 失效；现在这类轮次直接不判定，只写一行「已打断，未判定」。

> 如果你看到的是旧行为（按 Esc 后又被催），先确认当前会话的进程开在修复之后：本包在运行中的进程里不会热更新，需要 `/reload` 或重开会话。

两件事同时成立时才算「这一轮没有判定」：页脚还停在上一轮的结论，且没有任何新提示。常见原因是当前不是 tui/rpc 模式、你已经在打字，或上面这两种不判定的轮次。


同一轮的结论只发一条消息块（正文一行 + `Ctrl+O` 展开的细节），不再另外弹提示；`notifyOnStopDecision` 已废弃（保留字段以免旧配置报错，但不再起作用）。颜色只在 TUI 下添加，其他模式不会出现 ANSI 乱码。

### 判定调用为什么不会“空响应”

判定只需要一个 JSON 结论，但推理型模型会先把输出预算花在思考上。历史上 `judgeMaxTokens` 固定为 400，一旦思考把预算吃光，响应里就只剩思考块、没有任何文本，用户看到的是含糊的「无法解析的响应：（空响应）」。现在：

- 判定调用固定使用最低思考强度（Pi 会收敛到模型支持的最低档，不支持关闭思考的模型也不报错）；
- 输出上限默认 2000，并可用 `judgeMaxTokens` 调整；
- 若仍然被截断且没有文本，自动用翻倍预算重试一次；
- 仍失败时，错误文案带上 `stopReason` 与内容块摘要（如 `结束原因=length，内容块=thinking:400`），不再只说「空响应」。

### 命令

- `/config:auto-goal` — TUI 配置菜单（别名：`/auto-goal`、`/pi-auto-goal-config`）。
- `/config:auto-goal enable|disable|status|reset` — 非交互式写法；`status` 显示生效配置与本会话已干预次数。配置命令改完立即生效。

## 开发

```bash
cd packages/pi-auto-goal
npm run typecheck
npm test
npm run check
```

测试是确定性的：判定调用可以注入替身，不需要 API key 或真实模型。
