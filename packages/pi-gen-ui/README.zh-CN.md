# pi-gen-ui

`pi-gen-ui` 把 [json-render](https://json-render.dev) 的 JSON spec 渲染成 Pi 终端里的原生面板。模型用一份扁平的 spec 描述界面，扩展用真正的终端组件把它画在会话区里：表格、柱状图、迷你折线、提示块、时间线，以及可键盘操作的输入控件。

两个工具：

| 工具 | 作用 |
| --- | --- |
| `render_ui` | 渲染你自己写的 spec，元素树完全由你控制。 |
| `compose_ui` | 把布局决策交给 TypeSafe 的决策模型（Jev），你只提供候选元素。需要 API key，见[组合](#组合可选)。 |

## 它改变了什么

没有这个包时，模型只能用散文或 markdown 表格描述一个看板。有了它，同样的回答会变成排好版的面板：

```
╭──────────────────────────────────────────────────────────╮
│ Deployments                                              │
│ ─────────────── services ───────────────                 │
│  LIVE  Region: eu-west-1          ✔ all healthy          │
│ ╭──────────────────────────────────────────────────────╮ │
│ │Service     │ CPU │ Status                            │ │
│ │────────────┼─────┼───────────────────────────────────│ │
│ │api-server  │ 12% │ running                           │ │
│ │worker      │ 64% │ degraded                          │ │
│ ╰──────────────────────────────────────────────────────╯ │
│ TypeScript ████████████████████████ (76%)                │
│ CPU ▃▆▃█▄▇▂▆▅                                             │
│ │ Note                                                   │
│ │ worker latency is above the threshold for 5 minutes    │
╰──────────────────────────────────────────────────────────╯
```

面板直接画在工具行里，跟着会话滚动，并且能用 Pi 原本的工具结果展开功能看全部内容。spec 里含交互组件时，工具还会打开一个居中的悬浮面板，用户可以真的输入、选择、确认；操作后的 state 会回给模型。

## 组件

共 27 个组件，名字和 props 体系与 [`@json-render/ink`](https://github.com/vercel-labs/json-render/tree/main/packages/ink) 的标准 catalog 一致，所以给 Ink 写的 spec 在这里也能通过校验。

| 分组 | 组件 |
| --- | --- |
| 布局 | `Box`（行/列、gap、内边距、边框、背景）、`Text`、`Newline`、`Spacer` |
| 内容 | `Heading`、`Divider`、`Badge`、`Card`、`KeyValue`、`Link`、`StatusLine`、`List`、`ListItem`、`Markdown`、`Callout`、`Metric`、`Timeline` |
| 数据 | `Table`、`ProgressBar`、`Sparkline`、`BarChart`、`Spinner` |
| 交互 | `TextInput`、`Select`、`MultiSelect`、`ConfirmInput`、`Tabs` |

### 与 Ink 渲染器的差异

这个渲染器会把限制说清楚，而不是悄悄丢掉：

- **被忽略的 props 会被报告。** catalog 保留了 Ink 完整的 props 面，spec 才能互通；但 Pi 只实现其中一部分，凡是声明了却没生效的 prop 都会出现在工具结果里。
- **没有 flexbox。** `Box` 支持 `flexDirection`、`gap`、`alignItems`、`justifyContent`、内边距、边框和 `width` 提示，但不支持 `flexWrap` 和绝对定位。过长的行会按分配到的宽度重新渲染，文字换行而不是被截断。
- **`justifyContent` 需要主轴。** 横向可用；纵向没有固定高度可以分配，所以会被报告并改为从顶部堆叠。
- **颜色是字面 ANSI。** 支持命名终端色（`red`、`green`、`cyan`、`gray` 以及 `*Bright`）和 `#rgb`/`#rrggbb`/`rgb(r,g,b)`。不支持的字符串会被报告并保持无样式。不使用 Pi 的主题 token，因为 spec 指定的是具体颜色，而 Pi 没有 magenta/cyan/blue 这类 token 可以映射。
- **Markdown 是有意取子集。** 支持标题、粗体、斜体、行内代码、删除线、围栏代码块、列表、引用、链接、分隔线；表格和嵌套列表按普通文本行渲染。
- **没有移植 Ink 的 `exit` 和 `log` action。** Pi 面板不是独立应用，往 stdout 写会破坏 Pi 的渲染。

交互组件走 Pi 自己的按键处理：

| 组件 | 按键 |
| --- | --- |
| `Select` | `↑`/`↓` 移动，`Enter` 提交 |
| `MultiSelect` | `↑`/`↓` 移动，`Space` 切换，`Enter` 提交（遵守 `min`/`max`） |
| `TextInput` | 可打印字符输入，`Backspace` 删除，`Enter` 提交 |
| `ConfirmInput` | `y` / `n`（标签可配置） |
| `Tabs` | `←`/`→` 切换绑定的 tab |
| 任意 | `Tab` / `Shift+Tab` 切换焦点，`Esc` 关闭面板 |

## 组合（可选）

`compose_ui` 使用 json-render 的 catalog 约束式组合：你提供**原子候选**（组件名 + 具体 props 值 + 说明），TypeSafe 的 Jev 决策模型决定包含哪些、顺序和位置。Jev 不会发明 props 值，也不会执行 action；流程控制在代码手里。

```jsonc
{
  "prompt": "给 eu-west-1 画一个部署概览。",
  "candidates": [
    {
      "id": "panel",
      "description": "面板的外层容器。",
      "root": true,
      "element": { "type": "Box", "props": { "flexDirection": "column", "gap": 1 } }
    },
    {
      "id": "title",
      "description": "面板标题文本。",
      "element": { "type": "Text", "props": { "text": { "$state": "/title" }, "bold": true } }
    }
  ],
  "state": { "title": "Deployments" }
}
```

前提与注意：

- **凭据。** 默认 `auto` 模式会自动使用已有的 key，优先 TypeSafe 直连：
  - `TYPESAFE_API_KEY` → 通过本包自己的适配器打 `https://api.typesafe.ai/v1/systemone`，不需要 Vercel 账号。
  - `AI_GATEWAY_API_KEY` → 走 core 内置 evaluator 打 Vercel AI Gateway，需要该 Vercel team 绑了支付方式并开通 `typesafe-ai` provider。

  设置后重启 Pi。把 `composition.provider` 设为 `typesafe` 或 `gateway` 可以钉死某一种通道；钉死后缺 key 会直接报错，不会静默换到另一种。
- 只有存在可用 key 时才注册这个工具，所以平时不占提示词开销。
- 候选里用 `$state` 的 props 必须在 `state` 里有对应路径，否则组合器在调用评估端点之前就会拒绝候选。
- 上游 API 是 **experimental**（`experimental_composeSpec` / `experimental_createEvaluator`），可能随版本变化。因此本包把 `@json-render/core` 固定在精确版本，用动态导入 + 运行时探测：将来若上游移除这两个函数，`compose_ui` 会明确报错，`render_ui` 照常工作。
- 组合失败会如实报告，不会静默重试。工具结果会告诉模型改用 `render_ui` 自己写 spec。

### 两条通道

`typesafe` 通道存在的原因：core 把 Vercel AI Gateway 的端点写死在代码里，且没有 base URL 选项。本包不去改 core，而是利用 core 自己的 `fetch` 注入点：把请求改写到 TypeSafe 端点、补上 TypeSafe 要求的 `model` 字段，再把 TypeSafe 的 `answers[].confidence` 和 `usage.input_tokens` 折回 core 期望的结构。TypeSafe 的端点和 core 用的是同一套 `{ state, questions }` 协议与 `choice` 问题类型，所以候选与提示词都不用改。

## 配置

`<Pi agent 目录>/extensions/pi-gen-ui/config.json`（支持 `PI_CODING_AGENT_DIR`）：

```json
{
  "enabled": true,
  "maxResultLines": 60,
  "interactiveView": "auto",
  "composition": {
    "enabled": true,
    "provider": "auto",
    "model": "",
    "apiKeyEnv": "",
    "endpoint": "",
    "timeoutMs": 10000
  }
}
```

| 键 | 含义 |
| --- | --- |
| `enabled` | 关掉后 `render_ui` 不再渲染面板。 |
| `maxResultLines` | 工具结果在会话里最多画多少行，超出部分折叠成一行提示。 |
| `interactiveView` | `auto` 只在 spec 含交互组件时开面板，`always` 总是开，`never` 从不打开；工具调用的 `interactive` 参数优先。 |
| `composition.enabled` | 是否提供 `compose_ui`。 |
| `composition.provider` | `auto`（默认）优先 TypeSafe，没有它的 key 才退回 gateway；`typesafe` / `gateway` 钉死某一种通道。 |
| `composition.model` | evaluation model id。留空则用该通道的默认值：TypeSafe 是 `jev-latest`，gateway 是 `typesafe-ai/jev`。 |
| `composition.apiKeyEnv` | 存放 key 的环境变量名。留空则用该通道默认值（`TYPESAFE_API_KEY` 或 `AI_GATEWAY_API_KEY`）。 |
| `composition.endpoint` | TypeSafe 端点覆盖。留空用 `https://api.typesafe.ai/v1/systemone`。 |
| `composition.timeoutMs` | 单次评估超时。 |

命令：

```text
/config:gen-ui              查看当前配置
/config:gen-ui status       同上
/config:gen-ui enable|disable
/config:gen-ui catalog      重新生成组件参考文件并打印路径
/json-render                     别名
```

## 模型怎么知道有哪些组件

完整的组件参考**不会**注入 system prompt。它由渲染器所用的同一份 catalog 生成——所以不可能和校验逻辑脱节——写到 `<Pi agent 目录>/extensions/pi-gen-ui/catalog.md`，并在 `render_ui` 的工具说明里给出路径。模型只在真的要画界面时才用普通的 `read` 工具去读它。

这样常驻提示词成本只有一段简短的工具说明加一个路径，而不是每轮约 5.7k token 的组件文档。被拒绝的 spec 会把结构问题、props 问题和参考文件路径一起返回，模型可以自己修正。

## 限制

- 渲染需要 Pi 的 TUI。RPC/JSON/print 模式下工具仍会校验并返回摘要，但不会画面板。
- 交互组件只在悬浮面板打开期间接收输入，所以尽量放在顶层，不要藏在折叠或 repeat 分支里。
- 内置 action 只有 `setState`、`pushState`、`removeState`。`ActionBinding.confirm`、`onSuccess`、`onError` 会被报告为不支持，而不是半吊子实现。

## 开发

```bash
npm test
npm run typecheck
```

测试是确定性的：不联网、不需要 API key、不跑真实模型。组合路径通过注入的假网关覆盖。

## 出处

组件名、props 体系和 spec 语法遵循 [vercel-labs/json-render](https://github.com/vercel-labs/json-render)（Apache-2.0）。本包是独立的 Pi 渲染器，不内嵌 Ink 或 React。

## 许可

[MIT](../../LICENSE)
