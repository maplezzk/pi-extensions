# pi-spec 斜杠命令交互改造

- Mode: lightweight
- Status: 实现完成；包级 133 项与全仓门禁（12 包）通过，真实 TUI/RPC 与真实模型验收未运行
- 仓库：公开 pi-extensions
- 工作区：`/Users/zzk/GitWorktree/public-pi-spec-mode/pi-extensions`
- 分支：`feat/public-pi-spec-mode`
- 前置：`docs/plans/2026-09-06-001-fix-spec-workflow-reliability-plan.md`（状态可靠性改造）

## 用户问题

用户反馈「设计的很难用，特别是斜杠命令，还需要我记忆参数，和写 CLI 一样」。具体病灶：

| 现状 | 问题 |
| --- | --- |
| `/spec` 无参数只打印一行帮助文本 | 不提供菜单，用户得自己挑命令 |
| 无 `getArgumentCompletions` | Tab 键在 `/spec` 下什么都不补，7 个子命令靠背 |
| `/spec new <slug> --title "标题"` | `--title` 标志语法在聊天框里完全是 CLI 习惯 |
| `/spec use <slug>` | 要背 slug |
| `/spec revise <artifact>` | 要背 4 个 artifact 名 |
| `/spec approve` 埋得最深（一份规格要按 4 次） | 每次都要求用户主动输入命令 |

同仓对照：`pi-naming`、`pi-distill`、`pi-models-discovery`、`pi-metrics` 全部是「无参数开菜单 + `ui.input` 问值」，`pi-session-resources` 用了 `getArgumentCompletions`。pi-spec 是唯一的异类。

## 目标与边界

- 让用户「不记得参数就只打 `/spec`」，且 Tab 补全只列出当前状态合法的动作。
- 让最高频的批准不再需要用户输入命令。
- 保留全部 7 个子命令作为快捷方式，不破坏既有用法。
- 不做：新交互框架、命令重命名、删除子命令、自动批准、在没有人工按键的情况下推进阶段。

## 设计决定

1. **状态驱动的一级动作列表。** `src/actions.ts` 以纯函数给出「当前状态下合法动作」的唯一判定，菜单和 Tab 补全共用，避免两处条件分叉。首项为推荐动作：待批时是批准，实现执行中时是继续。
2. **补全只暴露合法动作。** 一级补全给动作，二级补全给参数：`use` 列磁盘规格（带标题），`revise` 只列已开始、可回退的阶段。非法状态下的动作不会出现在候选里。
3. **参数改为交互输入。** `/spec new` 用 `ui.input` 依次询问名称与标题（标题预填名称，回车即可）。旧 `--title` 仍然生效，不静默忽略，但不再出现在帮助与文档用法中。
4. **批准由模型发起、由用户按键完成。** 新增 `spec_request_approval` 工具：模型在文档待批时调用它，弹出与 `/spec approve` 完全相同的确认框。批准动作仍只由用户在对话框里按键产生；工具自身无法批准，headless 一律不批准。
5. **批准实现只允许一份。** 命令、菜单与工具共用 `performApproval`，其中保留原有的「快照 → 确认 → 复查 slug/epoch/phase/revision/SHA」双检查，避免三处各写一套后语义漂移。

## Plan Tasks

### TASK-action-model · 状态驱动的动作模型

- **Status:** done
- **Write scope:** `packages/pi-spec/src/actions.ts`；`packages/pi-spec/test/actions.test.ts`
- **Goal:** 菜单与补全共用同一份「当前合法动作」判定。
- **Acceptance:** 各阶段（未激活/恢复失败/起草/待批/执行中/完成）动作集合与首项明确；可回退阶段不含尚未开始的 verification；二级参数动作与前置校验名单各只有一份真相源。
- **Result:** 新增纯函数模块 `actions.ts`（`availableActions`、`revisableArtifacts`、`nextPhase`、`isArgumentAction`、`requiresPrepare`、`completionValue`、`argumentValue`）与 10 个确定性用例。

### TASK-interactive-entry · 菜单、补全与输入框

- **Status:** done
- **Write scope:** `packages/pi-spec/src/index.ts`；`packages/pi-spec/src/storage.ts`；`packages/pi-spec/locales/i18n.json`
- **Goal:** `/spec` 无参数开菜单；Tab 只补当前合法动作；`new`/`use`/`revise` 支持无参数交互。
- **Acceptance:** 无参数 `/spec` 在 TUI 开菜单、非交互模式列出动作；`use`/`revise` 无参数弹选择列表；未知子命令明确报告并回退菜单；取消不产生任何修改。
- **Result:** 新增 `listSpecs`（损坏条目保留并带原因，不隐藏不阻断）、`completeSpecArguments`、`cmdMenu`/`runAction`、`cmdStop` 与两个选择器。`ExtensionAPI` 无 `getCwd()`，补全回调通过最近一次事件缓存的项目目录取规格列表，该限制已写入双语文档。

### TASK-approval-request-tool · 模型可发起、人工按键完成批准

- **Status:** done
- **Write scope:** `packages/pi-spec/src/index.ts`；`packages/pi-spec/locales/i18n.json`；`packages/pi-spec/test/runtime.test.ts`
- **Goal:** 待批时不需要用户手敲 `/spec approve`。
- **Acceptance:** 仅待批状态暴露该工具；用户取消、无 UI、非待批状态下都不产生批准；确认期间文档变化仍拒绝批准；直接误调用被拒绝。
- **Result:** 抽出 `performApproval` 供命令与工具共用；新增工具与 8 个入口回归用例。工具只弹对话框，批准仍必须按键。

### TASK-docs · 双语文档与操作技能同步

- **Status:** done
- **Write scope:** `packages/pi-spec/README.md`；`packages/pi-spec/README.zh-CN.md`；`packages/pi-spec/SKILL.md`
- **Result:** 命令用法改为可选参数形式，新增菜单/Tab/审批工具的说明，明确「工具不能替你批准」与补全的目录限制。

## 验证

- 包级：`npm run check -w @maplezzk/pi-spec`（133 项测试、类型检查、`npm pack --dry-run`）通过。
- 全仓：`npm run check`（12 个包，全部 `fail 0`；本机解耦、双语 key 对齐、包登记门禁通过）。
- 新增用例覆盖：菜单选择批准、菜单取消、待批一级补全、未激活补全、二级补全、未知子命令、输入框新建、旧 `--title` 兼容、非法名称、`use`/`revise` 选择器、审批工具的批准/取消/headless/非待批/确认期改文档。

**NOT_RUN：** 真实 TUI PTY 与 RPC 宿主验收、真实模型提示遵循质量、真实人工审批。本轮只做确定性入口测试与类型/打包门禁，不据此声称 TUI 交互体验已验证。

## 已知限制

- 参数补全没有 session ctx，只能用最近一次会话或命令事件观察到的目录；跨目录补全需要显式事件先发生。
- `/spec<Tab>`（不含空格）由 Pi 的命令名补全处理，只显示命令描述；要拿到状态感知的动作列表需输入 `/spec ` 再按 Tab。这是宿主补全提供者的分支行为，本包无法注入。
- 旧的 `--title` 被保留为兼容路径，未从代码删除。

## 后续（已与用户确认方向，本轮未实现）

用户提出「spec 状态是否可以直接持久化在 markdown 里」。结论与推荐：

- **批准与阶段不能自证。** 如果把「已批准」写进被批准文档自己，模型用 `write`/`edit` 就能伪造批准，上游改动也无法判定失效。批准锚点必须留在模型不可随手写的机器文件里。
- **推荐方案：frontmatter 作为插件维护的派生显示层，`state.json` 仍是唯一真相。** 哈希口径改为只算 frontmatter 之后的正文，因此改进度不会让批准失效；两份不一致时以 `state.json` 为准并自动修复。这样保住单次 `renameSync` 原子提交，不回退上一轮四个任务修出的可靠性。
- **已排除：markdown frontmatter 当唯一真相。** 每次状态转换要写两个文件，崩溃会留下前后不一致，而修复流程本身无法完全消歧。
- **已排除：另写一份 `status.md`。** 没有解决「状态在文档里」的诉求。
- 该改造涉及持久化协议 v1 → v2 与哈希口径变更，需单独立项。
