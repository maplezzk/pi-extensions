# pi-spec 状态持久化到 markdown frontmatter

- Mode: lightweight
- Status: 实现完成；包级 156 项与全仓门禁通过，真实 TUI/RPC 与真实模型验收未运行
- 仓库：公开 pi-extensions
- 工作区：`/Users/zzk/GitWorktree/public-pi-spec-mode/pi-extensions`
- 分支：`feat/public-pi-spec-mode`
- 前置：`docs/plans/2026-09-06-001-fix-spec-workflow-reliability-plan.md`（状态可靠性改造）、`docs/plans/2026-09-10-001-spec-interaction-redesign-plan.md`（斜杠命令交互改造）

## 用户问题

用户要求：「spec 的状态是否可以持久化在 markdown 文件里，而不仅在内存里，markdown 文件自身既是可读文件也承载状态」。此前阶段/进度/审批只存在于 `state.json` 和内存，人打开 `tasks.md` 看不出这份规格到哪一步了。

## 目标与边界

- 打开任意规格文档就能看到名称、阶段、状态、审批结果与任务进度。
- 不放弃上一轮修出的可靠性：单次 `renameSync` 原子提交、批准与文档指纹绑定、批准竞态与漂移防护。
- 硬边界：**批准不能自证**。`approval: true` 写进被批准文档自身，等于模型用 `write`/`edit` 就能伪造批准，也无法判定上游改动是否让批准失效。
- 不做：把 frontmatter 提升为唯一真相（每次转换要写两个文件，崩溃留不一致）；不另建 status.md（没解决「状态在文档里」）。

## 设计决定

1. **`state.json` 仍是唯一真相，frontmatter 是派生显示层。** 由插件从 state 渲染并覆盖写入，读取时一律忽略。因此文档里出现 `approval: human` 不构成批准，也推不动阶段。
2. **文档指纹只覆盖 frontmatter 之后的正文。** 同步阶段、审批与进度不再让既有批准失效——上一轮的 bug 是「勾选进度 → 文件变 → 批准指纹失效 → 阶段回退」。
3. **字节级指纹。** 按 frontmatter 结束偏移对原始 buffer 切片求 sha256，不用 utf8 重新编码，避免无效字节导致的指纹漂移；无 frontmatter 的文档正文即全文，指纹与 v1 记录逐字节一致。
4. **不一致时以 `state.json` 为准并自动回正。** 激活/恢复规格时同步四份文档：缺失的补写、手工改过的回正，并提示改了哪几份。
5. **协议 v1 → v2。** 两版记录形状相同，差别只在指纹口径；读取兼容 v1 并就地升级 `schema` 标记，写入一律 v2。
6. **校验只看正文。** `spec_submit` 先同步派生头再取指纹，并把 frontmatter 剥离后交给文档校验器，避免头部内容影响校验结论。
7. **进度只在 tasks.md、且仅在已有任务时出现。** `tasks_done: 0/0` 是无意义噪声。

## Plan Tasks

### TASK-frontmatter-module · 派生层纯函数

- **Status:** done
- **Write scope:** `packages/pi-spec/src/frontmatter.ts`；`packages/pi-spec/test/frontmatter.test.ts`
- **内容：** `bodyOffset` / `stripFrontmatter` / `documentDigest` / `renderFrontmatter` / `withFrontmatter` / `frontmatterUpToDate` / `frontmatterFor`。区块识别容忍 CRLF 与空区块；未闭合分隔行按全文处理，不吞正文；标题用 JSON 转义保证单行。
- **Evidence:** `test/frontmatter.test.ts` 15 项通过，覆盖边界、指纹稳定性、幂等与手工区块替换。

### TASK-schema-v2 · 协议版本与兼容

- **Status:** done
- **Write scope:** `packages/pi-spec/src/state.ts`、`packages/pi-spec/src/storage.ts`、`packages/pi-spec/test/runtime.test.ts`
- **内容：** 新增 `STATE_SCHEMA`(v2) 与 `LEGACY_STATE_SCHEMA`(v1) 及 `SchemaVersion` 联合类型；`validState` 接受两版，`loadState` 统一升级为 v2 并补 `completedTasks`；未知版本仍拒绝。
- **Evidence:** 「v1 记录可读且升级为当前协议」「读取状态拒绝非法 schema」通过。

### TASK-sync-and-commit · 落盘即同步派生层

- **Status:** done
- **Write scope:** `packages/pi-spec/src/index.ts`
- **内容：** `syncFrontmatter`（缺文档跳过、已一致不重写、写失败逐条上报）、`repairFrontmatter`（激活/恢复时回正并提示）、`commitState`（先写 state.json 再同步派生层，最后刷新 UI 与会话快照）。原来散在 6 处的「saveState + state 赋值 + 三连同步」收敛为唯一入口；`cmdNew` 复用同一套派生逻辑写模板头。
- **Evidence:** 「新建规格：四份文档一开始就带派生 frontmatter」「提交与批准把审批状态写进文档头」「手工改坏文档头不改状态，重新激活时按 state.json 回正」「派生 frontmatter 写失败时明确上报，state.json 仍已落盘」通过。

### TASK-hash-scope · 指纹口径与提交校验

- **Status:** done
- **Write scope:** `packages/pi-spec/src/index.ts`
- **内容：** `sha256File` 与 `spec_submit` 统一走 `documentDigest`；提交前同步派生头；校验传入剥离 frontmatter 的正文。
- **Evidence:** 「任务进度写进 tasks.md 头，不让已批准的任务定义失效」「删掉文档头不算正文改动，已批准的上游不回退」通过；原 133 项哈希失效级联测试全绿。

### TASK-docs-and-procedures · 文档与阶段方法

- **Status:** done
- **Write scope:** `packages/pi-spec/README.md`、`README.zh-CN.md`、`SKILL.md`、`procedures/{requirements,design,tasks,verification}.json`、`locales/i18n.json`
- **内容：** 双语说明 frontmatter 契约（真相、指纹口径、冲突回正、v1 兼容）；四份文档阶段的模型方法各加一句「顶部 frontmatter 由扩展维护，不要手工编辑，也不要当作状态或批准依据」；新增 `frontmatter.notice`、`ui.frontmatterRepaired`、`errors.frontmatterSyncFailed` 双语句。
- **Evidence:** 全仓 i18n key 对齐门禁通过；`context.test.ts` 4 项通过。

## 验证

- `npm run check -w @maplezzk/pi-spec`：typecheck、156/156 测试（原 133 + 新增 23）、`npm pack --dry-run` 通过。
- `npm run check`（全仓）：12 个包全部 `fail 0`；`no-local-path`、`no-private-domain` 无命中；i18n 中英文 key 对齐；Package config check 12 包 0 warning。

## 已知限制与未运行项

- **NOT_RUN**：真实 TUI 交互、RPC 宿主、真实模型对 frontmatter 提示的遵循度。
- 参数补全仍只能用最近一次事件缓存的目录（宿主不提供 `getCwd()`），本次未改变。
- `taskIdsFromTasksMd` 在每次 UI 刷新/请求前会重读 `tasks.md`（既有行为，文件很小），本次未引入缓存。

## 兼容性影响

- 读取：v1 记录与无 frontmatter 的旧文档继续可用，激活时自动补齐文档头。
- 写入：新写入的 `state.json` 标记为 `pi-spec-mode/v2`；旧版本插件读到 v2 会明确拒绝（而不是按整文件指纹误判失效）。
- 文档：规格文档首次激活时顶部会多出一段注释与派生字段；正文逐字节不变。
