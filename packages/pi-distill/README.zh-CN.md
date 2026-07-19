# pi-distill

`pi-distill` 是一个控制工具结果进入 Agent 上下文规模的 Pi 扩展。

## 解决什么问题

编码 Agent 通常只需要命令、搜索或文件读取结果中的关键信息。把大段日志、生成文件或搜索结果完整塞入下一轮，会增加上下文消耗，也容易让有效信号被噪声淹没。`pi-distill` 在不替换 Pi 内置工具的前提下，增加一层结果级提炼。

## 工作方式

- 通过 Pi 原生的 `tool_call` / `tool_result` 事件监听 `bash`、`read`、`grep` 和 `find`。
- 以工具的 `outputPrompt` 作为是否提炼、如何提炼的依据。
- 当提示词严格只有 `RAW` 时，视为明确要求返回原始输出。
- 默认使用当前会话模型，也可以配置独立的 `provider/model`。
- 在工具结果 details 中保留状态、字符数、压缩比、耗时和异常等诊断信息。
- 提炼结果或最终返回结果过大时写入临时文件，只把文件路径返回给 Agent，避免工具结果失控膨胀。
- 当前 Pi 展示中间件可用时显示紧凑审计卡片，否则使用自己的 fallback renderer。

它不会注册第二个 `bash`、`read`、`grep` 或 `find` 工具，也不依赖 `pi-tool-display`。

## 安装

```bash
pi install npm:pi-distill
```

安装后重新加载 Pi：

```text
/reload
```

随时可以使用交互式配置命令：

```text
/pi-distill
```

## 配置

默认配置路径：

```text
~/.pi/agent/extensions/pi-distill/config.json
```

可以从 [`config.example.json`](./config.example.json) 开始：

```json
{
  "enabled": true,
  "model": "",
  "minChars": 200,
  "maxChars": 100000,
  "maxOutputChars": 10000,
  "timeoutSeconds": 10,
  "missedCompressionRatio": 10,
  "summarizeErrors": true,
  "render": {
    "enabled": true,
    "showPrompt": true,
    "showResult": true
  }
}
```

配置文件字段优先于环境变量。未在文件中声明的字段依次回退到 `PI_DISTILL_*`、旧版 `PI_BASH_SUMMARY_*` 变量和默认值。

| 配置项 | 含义 |
| --- | --- |
| `model` | 可选的 `provider/model`；为空时使用当前 Pi 会话模型。 |
| `minChars` | 达到此输出长度后才请求提炼。 |
| `maxChars` | 模型提炼结果超过此长度时写入文件。 |
| `maxOutputChars` | 返回给 Agent 的最大长度，超出后写入文件。 |
| `timeoutSeconds` | 提炼模型调用的最长等待时间。 |
| `missedCompressionRatio` | 没有提供摘要提示时，用于长输出诊断的倍数阈值。 |
| `summarizeErrors` | 工具返回错误时是否仍发送给提炼模型。 |
| `render.*` | 控制审计卡片、提示词预览和结果预览。 |

主要环境变量包括 `PI_DISTILL_MODEL`、`PI_DISTILL_MIN_CHARS`、`PI_DISTILL_MAX_CHARS`、`PI_DISTILL_MAX_OUTPUT_CHARS`、`PI_DISTILL_TIMEOUT_SECONDS`、`PI_DISTILL_MISSED_COMPRESSION_RATIO` 和 `PI_DISTILL_SUMMARIZE_ERRORS`。

## 重要行为

提炼不是无损操作。需要完整输出时，应让工具请求 `RAW`；扩展会保留原始结果，不再请求模型总结。如果请求了摘要但没有可用模型，扩展会保留原始结果，并通过诊断信息暴露失败，不会阻止 Pi 启动。

## 要求

- Node.js 22 或更高版本。
- 当前 Pi 会话需要有可用模型，除非 `model` 指向一个已配置且可用的模型。

## 许可证

[MIT](../../LICENSE)
