# pi-tool-supervisor

`pi-tool-supervisor` 是 Pi 的可配置工具生命周期审查扩展。它可以在选定工具执行前后按规则审查，并对 `edit`、`write` 使用真实文件变化。

## 解决什么问题

编辑工具成功执行，并不代表结果符合项目约定、架构边界、安全规则或任务要求。对真实的前后文件 diff 执行模型审查，可以及时发现这些问题，同时把审查策略保留在项目可配置的规则文件中。

## 工作方式

- 每个 reviewer 可选择 `tools`、`trigger`，并可选配置本地 `condition` 模块；省略时保持旧默认：`edit`/`write` + `after`，`"*"` 匹配全部内建和自定义工具。
- before reviewer 审查执行前输入，明确拒绝会通过 Pi 原生机制阻断调用；模型审查失败仍 fail-open，但不会把错误追加给 Agent，审计卡片仍保留失败状态；condition 模块加载或执行失败会阻断 before 调用。
- 在 `edit` / `write` 前捕获文件状态，在工具返回后读取实际文件状态。
- 将带真实行号的修改后文件与 diff 一起发送；超过 `maxFileContextChars` 时，截取首次和末次变更附近并明确标记截断。
- 构建 diff，并只选择规则文件匹配当前变更文件的 reviewer。
- 支持多个 reviewer 并行执行，每个 reviewer 可以使用自己的模型和一个或多个规则文件。
- 读取规则文件可选的 front matter：`enabled`、`filePatterns`、`complexity` 和 `consumers`。
- 返回 `passed`、`rejected`、`failed` 或 `skipped` 状态，以及结论、发现、规则组和耗时。
- 只在审查结论自洽时才采纳拒绝：`passed: false` 但没有任何 finding 时会降级为通过并附上说明，避免自相矛盾的审查阻断没有可修项的编辑。
- 原样透传工具结果，不截断，也不把工具输出写入临时文件；输出控制由 Pi 或其他扩展负责。
- 每次工具调用都重新读取配置，因此配置修改会在下一次匹配操作立即生效。
- 当前 Pi 展示中间件可用时显示审计卡片，否则使用 fallback renderer。展示协议由公共运行库 `pi-extensions-tool-display` 提供。

它监听 Pi 原生事件，不会注册替代版 `edit` 或 `write` 工具。

## 审查引擎

每个 reviewer 用 `backend` 选择审查引擎；省略时保持原有行为。

| `backend` | 由谁判断 | 开销 | 结果形态 |
| --- | --- | --- | --- |
| `model`（默认） | 一个 Pi 对话模型，把全部规则和 diff 放进一次 prompt 里读 | 每个 reviewer 一次对话补全 | 自由文本 JSON：`passed`、`summary`、`findings` |
| `typesafe` | TypeSafe System One，一次批量请求里每条规则一个 typed question | 实测 3 条规则的 reviewer：约 1-2 秒、约 1,400 input token、每次审查约 US$0.00006 | 每条规则一个校准过的 `noul` 概率；阈值由代码判定 |

### TypeSafe 引擎

`typesafe` 把规则文件里的每一条编号条款变成一条 Noul 问题——“`diff` 中新增或修改的代码是否违反这一条？”——答案是概率。同一 reviewer 的全部条款放在一次请求里问，因为 TypeSafe 会对同一份 state 并行回答所有问题。剩下的都由代码控制：`threshold` 决定算不算命中，命中后用一次更小的 Choice 请求把问题定位到 diff 真正新增的那一行。

**规则文件是引擎无关的：换 backend 只改一行 config，规则文件一个字符都不用动。** 不需要 `## 判据` 段落，不需要声明级别，不需要分块标题。

API Key 优先从 `config.json` 顶层的 `typesafe.apiKey` 读取，没配时回退到 `TYPESAFE_API_KEY` 环境变量；`typesafe.endpoint` 同理，没配时回退到 `TYPESAFE_ENDPOINT`，都没有就用官方地址。key 缺失、请求失败或规则文件切不出条款都会产生可见的 `failed` 审计条目，不会阻断工具，与对话模型审查失败时的行为一致。

#### 怎么启用

1. 确保装的是带本后端的版本（`pi update --extensions`）。
2. 在 `config.json` 顶层加 TypeSafe 连接设置（`endpoint` 可省略，默认官方地址）：

```json
"typesafe": {
  "apiKey": "<your-typesafe-api-key>"
}
```

3. 把要切换的 reviewer 改成 `typesafe` 引擎（`model` 字段要去掉）：

```json
{
  "name": "code-taste",
  "backend": "typesafe",
  "typesafeModel": "jev-latest",
  "rulesFiles": ["/absolute/path/to/javascript-typescript.md"],
  "tools": ["edit", "write"],
  "trigger": "after"
}
```

规则文件不用动。改完后重启 Pi 会话（或 `/reload`）生效；先挑一个规则文件试几天，看误报和漏报再扩到其他 reviewer。

#### 它怎么读你的规则文件

```markdown
---
name: javascript-typescript
filePatterns: ["**/*.ts"]
---
# JavaScript / TypeScript 规则

## 归属（优先于以上条款）

1. `ruleGroup` 只能填本文件里原样出现的条款名或编号。   ← 报告要求，不参与判断
2. 禁止越界：不要报本文件没写的规则。                    ← 报告要求，不参与判断

## 必须遵守

1. **禁止魔法值**：业务逻辑中的非显而易见数字必须提取为有语义的 `const` 或集中配置。
2. **最多 3 个参数**：声明中出现 4 个或更多参数时必须改为参数对象。
3. **禁止 any**：优先使用具体类型；无法确定时使用 `unknown` 并在边界处收窄。
   不要用 `as any` 或 `any[]` 绕过类型检查。
```

切成 **3 条独立规则**：

| 判断 id | 规则名（就是 finding 里的 `ruleGroup`） | 判据 | 命中 | 结果 |
| --- | --- | --- | --- | --- |
| `rule_1` | `必须遵守 1 禁止魔法值` | 条款原文 | 0.52 | 未命中 |
| `rule_2` | `必须遵守 2 最多 3 个参数` | 条款原文 | 0.03 | 未命中 |
| `rule_3` | `必须遵守 3 禁止 any` | 条款原文 | **0.97** | 阻断，定位到第 3 行 |

一条条款的正文**既是判据也是 finding 文案**。三条条款是三个独立的 Noul 问题，**在同一次请求里并行回答**。

#### 切分规则

| 你写的东西 | 它怎么处理 |
| --- | --- |
| `1. 正文` 编号条款 | 一条规则；缩进的续行拼进同一条 |
| 以「归属」开头的段落里的编号 | **不参与判断**——那是「怎么报告」，不是「什么代码算违规」 |
| 条款开头历史遗留的 `[error]` / `[warning]` | 会从判据里剔掉；没有分级，**命中即阻断**（老规则文件不用改） |
| 条款里的 `**粗体**` | 当规则名，拼成 `{段落} {编号} {标题}`，就是 finding 里的 `ruleGroup` |
| front matter 的 `threshold` | 该文件全部条款的命中阈值；不写默认 `0.85` |
| 其他散文、`## 输出` 这类段落 | 不影响判断 |
| 放行条件的编号列表（「只读」「只跑脚本」这类） | 仍会一条一条切成规则，但问的方向是反的——见下文 |

以「归属」开头的段落名（常见规则文件里写作 `## 归属与 severity…`）在判定时一律跳过，所以「
`ruleGroup` 只能填本文件里原样出现的条款名」这类报告要求不会变成代码规则。

编号条款必须写「什么代码算违规」。把**放行条件**（「只读」「只跑脚本或模块」「拿不准就判 passed」）写成编号列表，它们不会消失：每条都会变成一条规则，被问成「这段代码是否违反『只读』这条规则」，语义正好反过来；而真正的禁令如果写成了无序列表或散文，反而一条都不会被问。**切得出条款不等于切对了条款**，所以下面「缺条款时报错」那道闸门拦不住这种文件：它确实切得出条款，只是切出来的不是禁令。条款一律写禁令，豁免条件写进被豁免的那条条款里。

#### 不通过时能看出是哪一条

每条命中的条款各产生一条 finding，规则名就是文件里那条条款的叫法：

```
发现 2 处必须修正的问题
- [必须遵守 1 禁止魔法值] 第 5 行：业务逻辑中的非显而易见数字必须提取为有语义的 `const`…
  命中代码：const fallback = 30000;
- [必须遵守 4 禁止 any] 第 3 行：优先使用具体类型；无法确定时使用 `unknown`…
  命中代码：const raw = (config as any).timeout;
```

同一个 reviewer 的 `summary` 也逐条列出 noul，形如 `2 条规则命中：必须遵守 1 禁止魔法值=0.92, 必须遵守 4 禁止 any=0.97`。

一次请求问 N 条，所以条款变多几乎不增加延迟：实测 6 条条款（2,438 input token）和 10 条规则批量一次 1.1 秒 / 1,351 input token；拆成 10 次请求则是 4.3 秒 / 7,525 input token。

#### 缺条款时报错，不静默通过

规则文件里一条编号条款都切不出来（比如整份都是散文、或者编号写成了无序列表）时报 `failed` 并带文件路径，**不会被当成通过**。否则启用 typesafe 后规则会静默失效。

#### 限制

把 `typesafe` reviewer 当门禁之前需要知道的限制：

- **条款写得多具体，判得就多准。** 概率判不准的时候，该改的是那句话怎么写（把豁免条件列清楚），不是换格式。实测：「非显而易见数字必须提取为有语义的常量」里的「有语义」太主观，`const fallback = 30000;` 只给 0.52；而「禁止 `any`」这种边界清楚的条款给 0.97。
- **阈值按文件调。** 目前 `threshold` 是文件级。同一个文件里条款的好坏差异大时，只能靠把条款写清楚，不能逐条调。
- **没有分级。** 两个后端一致：条款命中就阻断。规则文件里历史遗留的 `[error]` / `[warning]` 标注会被剔掉，不改变判定。
- 行号定位需要修改后的文件内容。`before` 审查只有 `write` 拿得到，所以 `edit` 的 before 审查只报规则级问题、不给行号。
- diff 新增超过 40 行时会跳过行定位，并在审计里给出警告；规则级问题仍然照常报告。
- 会把整份修改后文件作为上下文发出，受 `maxFileContextChars` 限制；相比只发 diff，输入 token 大约翻倍。
- 会把每条条款的原文都发出去，所以条款越详细输入 token 越高（实测 6 条约 2.4k input token）。
- 概率是校准过的判断，不是事实保证。

## 安装

```bash
pi install npm:pi-tool-supervisor
```

包清单会把共享依赖 `pi-extensions-tool-display` 作为一个扩展入口加载，不需要额外安装宿主包。

安装后重新加载 Pi：

```text
/reload
```

使用交互式配置命令：

```text
/config:tool-supervisor
```

## 配置

默认配置路径：

```text
~/.pi/agent/extensions/pi-tool-supervisor/config.json
```

可以从 [`config.example.json`](./config.example.json) 开始：

```json
{
  "enabled": true,
  "timeoutSeconds": 10,
  "maxFileContextChars": 50000,
  "maxRuleLines": 100,
  "typesafe": {
    "apiKey": "<your-typesafe-api-key>",
    "endpoint": "https://api.typesafe.ai/v1/systemone"
  },
  "reviewers": [
    {
      "name": "project-rules",
      "model": "provider/model",
      "rulesFiles": [
        "/absolute/path/to/rules.md"
      ],
      "tools": ["edit", "write"],
      "trigger": "after",
      "condition": "/absolute/path/to/condition.ts"
    },
    {
      "name": "code-taste",
      "backend": "typesafe",
      "typesafeModel": "jev-latest",
      "rulesFiles": [
        "/absolute/path/to/javascript-typescript.md"
      ],
      "tools": ["edit", "write"],
      "trigger": "after"
    }
  ]
}
```

每个 reviewer 必须提供 `provider/model` 格式的模型（`model` 引擎）或 `typesafeModel`（`typesafe` 引擎），并提供 `rulesFile` 或 `rulesFiles`。相对规则文件和 condition 模块路径按当前项目工作目录解析。

| 配置项 | 含义 |
| --- | --- |
| `enabled` | 启用或关闭审查层。 |
| `timeoutSeconds` | 每个 reviewer 模型调用的最长等待时间。 |
| `maxFileContextChars` | 发送给 reviewer 的修改后文件上下文上限，默认 50,000 字符；超大文件仅发送首次和末次变更附近的有界片段并明确标记。 |
| `maxRuleLines` | 单条审查规则允许读取的最大行数。 |
| `typesafe` | TypeSafe 引擎的连接设置；有 `apiKey` 和 `endpoint` 两个字段，都可省略并回退到同名环境变量。 |
| `backend` | `model`（默认）或 `typesafe`，选择审查引擎。 |
| `typesafeModel` | `typesafe` 引擎使用的 TypeSafe 模型名，默认 `jev-latest`。 |
| `reviewers` | reviewer 名称、模型、规则文件、`tools`、`trigger` 和可选的 condition 模块；省略生命周期字段时保持旧的 `edit`/`write` + `after` 行为。 |
| `condition` | 可选的本地 TypeScript/ESM 模块路径。默认导出函数会收到 Pi 原生工具事件、`ExtensionContext` 和 `ToolConditionHelpers`；返回 `false` 时跳过该 reviewer，不调用模型。 |

规则文件可以通过 front matter 限定适用文件或消费者：

```yaml
---
name: TypeScript safety
enabled: true
filePatterns:
  - "**/*.ts"
complexity: local
consumers:
  - editor-review
---
```

`filePatterns` 使用简化 glob：`*` 不跨 `/`，`**` 可以跨目录，任意位置的 `**/` 都可匹配零层或多层目录。反斜杠会归一化为 `/`，开头的 `./` 会被忽略。

`threshold` 是 `typesafe` 引擎专用的可选 front matter 字段，默认 `0.85`；`model` 引擎忽略它。

### Condition 模块

reviewer 可以将 `condition` 设置为本地 TypeScript 或 ESM 模块路径。相对路径按当前项目工作目录解析，`~` 会按 Pi home 目录展开。模块必须默认导出一个同步或异步函数：

```ts
import type {
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { ToolConditionHelpers } from "pi-tool-supervisor";

export default function condition(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  helpers: ToolConditionHelpers,
): boolean {
  if (event.toolName !== "bash") return false;
  const command = event.input.command;
  if (typeof command !== "string") return false;

  // 可以直接使用 Pi 原生 event/context；解析器是可选辅助。
  const ast = helpers.parseBash(command);
  return ast.errors?.length === 0 && ast.commands.some((statement) =>
    statement.command.type === "Command" && statement.command.name?.value === "mvn",
  );
}
```

第一个参数是 `before` reviewer 收到的原始 `tool_call` 事件，或 `after` reviewer 收到的原始 `tool_result` 事件。第二个参数是原生 `ExtensionContext`，condition 模块可以使用其他 Pi 插件能使用的 context 能力。第三个参数提供 `parseBash(source)`。

condition 返回 `false` 时跳过该 reviewer，不读取其规则文件，也不调用模型。模块加载失败、执行失败、返回非 boolean 或超时会生成可见错误；`before` 会将其视为审查门禁失败并阻断工具。需要阻断工具时使用 `trigger: "before"`，`after` 仍然只提供诊断。

## 审查语义

- before reviewer 明确拒绝会阻断 Pi 原生工具调用，并把完整 reason 展示给 Agent；模型失败/跳过会放行，但失败信息只保留在审计详情中，不追加到 tool result。condition 模块加载或执行失败会阻断 before 调用。
- after 拒绝只提供诊断并展示给 Agent，不回滚已完成的工具调用；after 模型失败只保留在审计详情中，不追加错误诊断；工具失败时跳过 after 审查并保留原始错误。
- 审查拒绝和配置警告通过 Pi 的 `ctx.ui.notify` 展示；审查失败保留在审计卡片中，不向 Agent 注入错误文本；扩展不直接调用 `console.warn` 或 `console.error`。
- 如果用户打断上级 Agent 请求，所有尚未完成的 reviewer 模型请求会一起取消；尚未发起的 reviewer 会跳过；上级中断记为 skipped，而不是模型调用失败。
- 工具调用失败或文件内容没有变化时跳过审查。
- 扩展不会回滚编辑、阻断操作系统，也不替代 Pi 的权限与沙箱控制。

从 `pi-file-edit-review` 升级时，如果新配置不存在，扩展会读取旧配置；通过 `/config:tool-supervisor` 保存后会写入新的配置路径。`/pi-tool-supervisor` 仍作为兼容别名保留。

## 要求

- Node.js 22 或更高版本。
- 每个启用的 `model` reviewer 需要一个已配置的 Pi 模型。
- 每个启用的 `typesafe` reviewer 需要一个 TypeSafe API Key：优先读 `config.json` 里的 `typesafe.apiKey`，未配置时读 `TYPESAFE_API_KEY`。
- 需要提供描述项目级检查项的规则文件。

## 许可证

[MIT](../../LICENSE)
