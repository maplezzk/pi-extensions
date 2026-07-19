# pi-distill

`pi-distill` 是一个控制工具结果进入 Agent 上下文规模的 Pi 扩展。

## 解决什么问题

编码 Agent 通常只需要命令、搜索或文件读取结果中的关键信息。把大段日志、生成文件或搜索结果完整塞入下一轮，会增加上下文消耗，也容易让有效信号被噪声淹没。`pi-distill` 在不替换 Pi 内置工具的前提下，增加一层结果级提炼。

## 实际上下文节省效果

构建日志、diff 输出和测试报告经常包含重复状态行、未变化上下文、堆栈噪声，以及下一步决策并不需要的细节。这些内容通常很适合高比例压缩。下面这张真实 Pi 会话截图中，结果从 51,215 个字符压缩到 240 个字符：**213.40 倍压缩，输出字符减少 99.5%**。

![pi-distill 上下文节省示例](./assets/context-savings-example.png)

截图统计的是字符减少比例，不是 tokenizer 得出的精确 token 统计。实际使用时通常会带来同量级的上下文 token 节省，但精确数值取决于语言、内容和模型 tokenizer。对于适合压缩的冗长输出，90% 以上是已经观察到的效果，但不是每个命令的保证；需要完整输出时请使用 `RAW`。

| 场景 | 常见噪声 | 提炼结果保留 |
| --- | --- | --- |
| 构建 / 编译 | 重复进度、警告和未变化的环境信息 | 成功/失败、首个可行动错误、受影响文件和后续步骤 |
| Diff 检查 | 大量未变化 hunk 和格式化噪声 | 变更文件、相关 hunk 和评审所需事实 |
| 测试 | 单测逐条输出、snapshot 和框架模板 | 总数、失败用例、关键断言和有效诊断 |

## Prompt 语言

提炼 prompt 会严格跟随 `/pi-language` 当前选择的语言。持久化语言发生变化后，下一次工具调用会读取新设置，即使语言命令和 `pi-distill` 来自不同的包实例也可以同步。`PI_EXTENSIONS_LOCALE` 仍然是显式的环境变量覆盖项。原始用户消息只作为语言上下文传入，不能覆盖已选择的语言。

## 工作方式

- 自动发现所有参数 schema 为 object 的已启用工具，并通过 Pi 原生的 `tool_call` / `tool_result` 事件监听其结果。
- 以工具的 `outputPrompt` 作为是否提炼、如何提炼的依据。
- 当提示词严格只有 `RAW` 时，视为明确要求返回原始输出。
- 默认使用当前会话模型，也可以配置独立的 `provider/model`。
- 在工具结果 details 中保留状态、字符数、压缩比、耗时和异常等诊断信息。
- 提炼结果或最终返回结果过大时写入临时文件，只把文件路径返回给 Agent，避免工具结果失控膨胀。
- 当前 Pi 展示中间件可用时显示紧凑审计卡片，否则使用自己的 fallback renderer。

它不会注册替代工具，也不依赖 `pi-tool-display`。

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
