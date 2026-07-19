# pi-distill

Pi 工具输出提炼扩展。它统一处理 `bash`、`read`、`grep`、`find` 的 `outputPrompt`，不再局限于 Bash。

## 安装

该包独立扩展最终生效工具的参数 schema，并通过 Pi 原生 `tool_call` / `tool_result` 事件处理结果，不依赖 `pi-tool-display`，也不会注册同名工具。未安装、未启用或未接管对应工具时，会显示 UI-only 提炼审计；可用时则通过通用 result render middleware 把同一张卡片放进对应工具结果。`pi-tool-display` 不读取或解释 distill 字段。

通过 npm 安装：

```bash
pi install npm:pi-distill
```

安装后用 `/reload` 重新加载扩展。

## 配置

交互式配置命令：

```text
/pi-distill
```

配置文件保存在 Pi 全局扩展目录下，文件名为 `config.json`（设置 `PI_CODING_AGENT_DIR` 时使用该环境变量下的对应路径）。可通过 `/pi-distill` 交互命令查看或修改。

示例：

```json
{
  "enabled": true,
  "model": "provider/model",
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

`render.enabled` 控制提炼审计渲染；`render.showPrompt` 和 `render.showResult` 分别控制是否显示 AI 传入的 `outputPrompt` 和提炼模型返回的文本。配置会随工具结果写入 `details.outputSummaryRender`，由 pi-distill 自己的 fallback 或 result middleware 读取，因此两条渲染路径使用同一组开关。较长文本折叠时显示预览，展开工具输出后显示完整内容。

配置文件字段优先于环境变量。没有对应文件字段时，优先读取新变量：

- `PI_DISTILL_MODEL`
- `PI_DISTILL_MIN_CHARS`
- `PI_DISTILL_MAX_CHARS`：提炼结果字符上限，默认 `100000`；超过后写入临时文件
- `PI_DISTILL_MAX_OUTPUT_CHARS`：最终返回字符上限，默认 `10000`；超过后写入临时文件
- `PI_DISTILL_TIMEOUT_SECONDS`：提炼模型最长等待秒数，默认 `10`
- `PI_DISTILL_MISSED_COMPRESSION_RATIO`
- `PI_DISTILL_SUMMARIZE_ERRORS`：工具返回 `isError: true` 时是否仍调用提炼模型，默认 `true`；设置为 `false` 或 `0` 可关闭

旧版 Bash 变量继续兼容，作为回退：

- `PI_BASH_SUMMARY_MODEL`
- `PI_BASH_SUMMARY_MIN_CHARS`
- `PI_BASH_SUMMARY_MAX_CHARS`
- `PI_BASH_SUMMARY_MAX_OUTPUT_CHARS`
- `PI_BASH_SUMMARY_TIMEOUT_SECONDS`
- `PI_BASH_SUMMARY_MISSED_COMPRESSION_RATIO`

配置修改后下一次工具调用立即生效，不需要重启 Pi。总结模型会优先按原始用户消息使用相同的自然语言输出（不可用时使用 `outputPrompt` 的语言）；如果请求语义是返回原文、完整输出、逐字返回或不要总结，模型只返回 `RAW`，扩展再按 RAW 处理，不让模型重复输出原文。无论是否调用模型，最终返回内容都不会超过 `maxOutputChars`；超过时会写入 `/tmp/pi-distill/` 临时文件。
