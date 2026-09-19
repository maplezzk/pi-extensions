---
name: configure-pi-gen-ui
description: "配置与排查 pi-gen-ui 的面板渲染、交互面板、结果行数上限与 Jev 组合。Use when configuring json-render panels or diagnosing render_ui/compose_ui."
---

# 配置 pi-gen-ui

配置文件为 `<Pi agent 目录>/extensions/pi-gen-ui/config.json`（支持 `PI_CODING_AGENT_DIR`）。默认值见包内 `config.example.json`：

```json
{
  "enabled": true,
  "maxResultLines": 60,
  "interactiveView": "auto",
  "composition": { "enabled": true, "provider": "auto", "model": "", "apiKeyEnv": "", "endpoint": "", "timeoutMs": 10000 }
}
```

| 配置项 | 作用 |
| --- | --- |
| `enabled` | 关掉后 `render_ui` 不再渲染面板，直接返回提示。 |
| `maxResultLines` | 工具结果在会话里最多画多少行，超出部分折叠成一行提示，展开后可见全部。 |
| `interactiveView` | `auto` 只在 spec 含交互组件时开面板，`always` 总是开，`never` 从不打开。工具调用里的 `interactive` 参数优先级更高。 |
| `composition.enabled` | 是否提供 `compose_ui`。 |
| `composition.provider` | `auto`（默认）优先 TypeSafe 直连，没有它的 key 才退回 Vercel AI Gateway；`typesafe` / `gateway` 钉死某一种通道，钉死后缺 key 直接报错，不会静默切换。 |
| `composition.model` | evaluation model id。留空用该通道默认值：TypeSafe 是 `jev-latest`，gateway 是 `typesafe-ai/jev`。 |
| `composition.apiKeyEnv` | 存放 key 的环境变量名。留空用通道默认值（`TYPESAFE_API_KEY` 或 `AI_GATEWAY_API_KEY`）。 |
| `composition.endpoint` | TypeSafe 端点覆盖，默认 `https://api.typesafe.ai/v1/systemone`。 |
| `composition.timeoutMs` | 单次评估超时。 |

命令：

```text
/config:gen-ui              查看当前配置
/config:gen-ui enable|disable
/config:gen-ui catalog      重新生成组件参考文件并打印路径
/json-render                     别名
```

改完配置文件执行 `/reload`。

## 排查

1. **没画出面板，只有一行摘要**：确认当前是 TUI 模式（非 TUI 时工具只返回文本摘要，结果里会写明模式）；再看 `enabled` 是否为 true。
2. **组件没出现 / 布局不对**：先看工具结果里的警告。被忽略的 props、未知组件、未定义的 children key、非数组的 repeat 都会逐条列出，不会静默丢弃。`Box` 不支持 `flexWrap` 与绝对定位；列方向的 `justifyContent` 因为没有固定高度会被报告并忽略。
3. **颜色没生效**：只支持命名终端色（`red`/`green`/`cyan`/`gray` 及 `*Bright`）和 `#rgb`/`#rrggbb`/`rgb(r,g,b)`。其他字符串会被忽略并报告。
4. **交互组件按键没反应**：键盘只在面板打开时可用。`interactiveView` 为 `never`、或 spec 里没有交互组件且用 `auto` 时不会开面板；非 TUI 模式也没有面板。
5. **`compose_ui` 工具不存在**：需要可用的 key。默认 `auto` 模式优先 `TYPESAFE_API_KEY`（直连 TypeSafe，不需要 Vercel），没有才用 `AI_GATEWAY_API_KEY`（Vercel AI Gateway，该 team 需开通 `typesafe-ai` provider 并绑支付方式）。设置后重启 Pi。用 `/config:gen-ui status` 可以看到实际解析到的通道与变量名；也可以在配置里显式关掉 `composition.enabled` 让它不再提示。
6. **`compose_ui` 报 HTTP 401/403**：key 无效或无权限。401 是 key 本身不对；403 在 Vercel 通道下通常是账号缺支付方式。换成 TypeSafe 通道往往更省事。
7. **`compose_ui` 报"上游 API 已变更"**：`@json-render/core` 不再导出 `experimental_composeSpec`/`experimental_createEvaluator`。该 API 是 experimental，本包把 core 固定在精确版本；要么回退 core 版本，要么用 `render_ui` 手写 spec。
8. **`compose_ui` 报候选不合法**：候选必须带 `id`、非空 `description`、`element.type`（必须是 catalog 里的组件名）；用了 `$state` 的 props 必须在 `state` 里有对应路径，否则组合器在调用评估端点前就会拒绝。
9. **模型不知道有哪些组件**：组件参考文件是 `<Pi agent 目录>/extensions/pi-gen-ui/catalog.md`，由 catalog 生成，每次 `session_start` 重写。模型需要先读它再写 spec；工具说明里有这个路径。

## 验证

让 agent 调用 `render_ui` 画一个含 `Table` 和 `Badge` 的 spec，确认面板出现在工具结果里、边框与列对齐正确；再画一个含 `Select` + `TextInput` 的 spec，确认面板打开、`Tab` 能切换焦点、`Esc` 关闭、最终 state 出现在工具结果里。`compose_ui` 需要真实凭据：TypeSafe 通道用 `TYPESAFE_API_KEY` 可以直接跑通（已验证）；gateway 通道还需要 Vercel 账号绑支付方式。无法验证时报告 `NOT_RUN`，不要用"应该可以"代替证据。
