# Plan: pi-terminal-mux — mux.ts 按终端后端拆分为独立文件

日期：2026-07-20 · 类型：refactor · 深度：Lightweight（3 个 U-ID）

## 问题框定

`packages/pi-terminal-mux/src/mux.ts` 单文件 2110 行 / 68KB，混杂 5 个后端实现（muxy/cmux/tmux/zellij/wezterm）+ headless 降级 + 后端探测 + shell 工具 + zellij 放置规划 + cmux JSON 解析。herdr/otty 已各自独立成文件。用户明确要求：每个终端拆一个文件。

## 范围边界

- **只动** `packages/pi-terminal-mux/` 内部源码结构
- **对外 API 零变化**：`src/index.ts` 导出的符号集合、签名、语义逐一保持；`package.json` exports 不动
- **不改行为**：纯代码搬移 + 派发方式重构；无功能增删
- **不做**：消费仓改动、版本号手改（走 release-please）、lockfile 大清洗

## 需求追溯

- R1 每个终端后端一个文件（muxy/cmux/tmux/zellij/wezterm/herdr/otty）
- R2 headless、探测、shell 工具等共享逻辑独立成模块
- R3 公开导出符号集合重构前后完全一致
- R4 26 个单测不修改即通过（允许改 import 路径，不允许改断言）

## 目标结构

```text
packages/pi-terminal-mux/src/
  index.ts            # 对外 API（更新内部 import 路径，导出符号不变）
  detection.ts        # muxLog / hasCommand / muxPreference / is*Available / getMuxBackend / muxSetupHint / AGENT_MUXY_PANE_ID / MuxBackend
  headless.ts         # headless surface/process 全套
  shell.ts            # shellEscape / isFishShell / exitStatusVar / tailLines / sleepSync / envPositiveInteger
  surface.ts          # 统一 surface API（createSurface/sendCommand/sendEscape/sendLongCommand/
                      #   readScreen/readScreenAsync/closeSurface/rename*/pollForExit），按 backend 派发
  backends/
    types.ts          # BackendOps 内部接口（不对外导出）
    muxy.ts
    cmux.ts           # 含 parseCmux* 纯函数（这些已对外导出，从 index 透出）
    tmux.ts
    zellij.ts         # 含放置规划（ZellijPlacementPlan 等已对外导出）
    wezterm.ts
    herdr.ts          # 自 src/herdr.ts 迁入
    otty.ts           # 自 src/otty.ts 迁入
  mux.ts              # 瘦 barrel：re-export 上述模块的原 mux.ts 公开符号（保 ./mux subpath 契约）
  herdr.ts            # 瘦 barrel：export * from "./backends/herdr.ts"
  otty.ts             # 瘦 barrel：export * from "./backends/otty.ts"
```

### 关键决策

- **D0（doc-review F-001，P0 裁决）保留 subpath barrel**：`package.json` exports 含 `./mux → src/mux.ts`、`./herdr → src/herdr.ts`、`./otty → src/otty.ts`，且 README 双语文档公开承诺这三个子路径导入。因此 U2 后 **不删除** 这三个文件，而是把它们改成瘦 barrel：`src/herdr.ts` / `src/otty.ts` 各一行 `export * from "./backends/herdr.ts"` 等；`src/mux.ts` 从 68KB 实现体瘦身为 re-export barrel（detection/headless/shell/surface/backends 的原 mux.ts 公开符号全部经此透出）。exports 不动、README 不失效、subpath 消费者零破坏。
- **D1 引入内部 BackendOps 接口做注册式派发**，而不是把统一 API 里的 switch 分支原样搬到各文件再靠函数互调。
  - 理由：switch 分支里 tmux/wezterm/muxy 的实现当前内联在统一 API 中，若不抽象接口，拆分后会出现 backends/* 与 surface.ts 双向 import 的循环依赖；接口派发让依赖单向（surface.ts → backends/*）。
  - 备选：保留 switch、把每个 case 抽成 backend 文件里的函数。拒绝理由：仍然要求 surface.ts 知道每个 backend 的全部函数签名，等于把 switch 换成 import 列表，耦合没变。
  - 可逆性：易（接口是模块内部的，不对外）。
- **D2 BackendOps 接口不对外导出**：`backends/types.ts` 只被内部 import；index.ts 不透出。避免把内部契约误升级成公开 API。
- **D3 herdr/otty 保持原生函数导出**：`createHerdrSurface` 等现有公开函数签名不动，仅文件位置迁移；它们同时被 surface.ts 的 BackendOps 适配层调用。
- **D4 状态归属**：`cmuxSubagentPane` 移入 `backends/cmux.ts`；`lastSplitSource` 移入 `surface.ts`（已核实：8 处写入全部在统一 createSurface/createSurfaceSplit 内，跨 6+ 后端共享，归 backend 会制造横向依赖）；muxy 广度优先分屏状态（`/tmp/muxy-subagent-pane-*` marker、lock file、panes/pos/base/dir JSON）移入 `backends/muxy.ts` 作为 ops 实现私有状态；`headlessProcesses` 移入 `headless.ts`。getLastSplitSource/clearLastSplitSource 由 surface.ts 导出、index 透出。
- **D5 parseCmux* / ZellijPlacementPlan 等已公开符号**：实现在对应 backend 文件，由 index.ts 直接透出（不再经过 mux.ts 中转）。
- **D6（F-002/F-003 裁决）renameHerdrTab / renameHerdrWorkspace**：维持现有透出路径不动——mux.ts barrel 继续 `export { renameHerdrTab, renameHerdrWorkspace } from "./backends/herdr.ts"`，index.ts 经 `export * from "./mux.ts"` 获得这两个符号（与今天完全一致）。index.ts herdr 显式导出块**不**加这两个符号，避免显式+star 双路径；仅更新注释指向 backends/herdr.ts。这样 `./mux` subpath 与包根的符号集合都逐字保持。
- **D7（F-007 裁决）BackendOps 只覆盖 per-surface 操作**：`create / createSplit / send / sendEscape / read / readAsync / close / rename` 八个方法，以 `Record<MuxBackend, BackendOps>` 全键填充（TS 编译期保证不缺后端）。`renameCurrentTab`、`renameWorkspace`、`renameAgent`、`pollForExit`、`sendLongCommand` 等不按 surface 对称的操作**不进** BackendOps，留在 surface.ts 内按现状调用各 backend 公开函数——避免为不对称能力发明 noop/抛错语义。

## U-ID 拆分

### U1 — 抽离共享基础设施模块（detection / shell / headless）

- **Goal**：把与具体后端无关的代码从 mux.ts 抽出，mux.ts 改为 import 这些模块（其余内容原地不动）
- **Requirements**：R2
- **Dependencies**：无
- **Files**：
  - 创建 `src/detection.ts`、`src/shell.ts`、`src/headless.ts`
  - 修改 `src/mux.ts`（删除已抽出代码，改为 import + 按需 re-export 保持 `export * from "./mux.ts"` 的符号集合）
- **Approach**：纯搬移。mux.ts 末尾对抽出的符号做 `export { ... } from "./detection.ts"` 等，保证此阶段 index.ts 一行不用改。
- **Behavior boundary**：调用方不可感知。
- **Acceptance**：`npm run check` 全绿（26/26 单测、typecheck、门禁）；`node -e` 对比 package root 导出符号集合与基线一致。
- **Verification**：`npm run check` + 导出 diff 脚本。

### U2 — 每后端一个文件 + surface.ts 注册式派发

- **Goal**：建 `backends/types.ts`（BackendOps）+ 5 个新 backend 文件，herdr/otty 迁入 backends/，统一 API 迁入 surface.ts 并改为注册表派发，重写 mux.ts 为瘦 barrel（仅 re-export）
- **Requirements**：R1、R2、R3、R4
- **Dependencies**：U1
- **Files**：
  - 创建 `src/backends/{types,muxy,cmux,tmux,zellij,wezterm}.ts`、`src/surface.ts`
  - 移动 `src/herdr.ts → src/backends/herdr.ts`、`src/otty.ts → src/backends/otty.ts`（原位置留下 barrel）
  - 修改 `src/index.ts`（import 路径；导出集合不变）
  - 重写 `src/mux.ts` 为瘦 barrel
  - 修改 `tests/mux.test.ts`（仅 import 路径，若有直接引用被移路径的符号）
- **Approach**：
  - 每个 backend 文件导出 `const ops: BackendOps` + 各自现有公开原生函数；
  - surface.ts 持有 `Record<MuxBackend, BackendOps>`，统一 API 逐函数改为查表调用；
  - zellij 放置规划、cmux JSON 解析随各自 backend 文件走；
  - herdr/otty 的 BackendOps 适配器薄包装现有原生函数。
- **Behavior boundary**：调用方不可感知；后端探测顺序、偏好 env、错误文案完全一致。
- **Acceptance**：同 U1 + `grep -rn "muxy\|createZellijSurfaceUnlocked" src/mux.ts` 无命中（实现已清空，仅剩 re-export）。
- **Verification**：`npm run check` + 导出 diff（基线 `/tmp/mux-exports-baseline.txt`，81 符号；diff 命令：`node --experimental-strip-types -e "import('./index.ts').then(m=>console.log(Object.keys(m).sort().join('\n')))" | diff - /tmp/mux-exports-baseline.txt`）+ `git diff --stat` 审阅。

### U3 — 消费仓 smoke 验证

- **Goal**：确认两大消费方在新结构下编译/测试通过
- **Requirements**：R3
- **Dependencies**：U2
- **Files**：无（只本地验证，不提交消费仓）
- **Approach**：在 `~/GitWorktree/terminal-mux-pkg/` 的 PiExtensions 与 pi-interactive-subagents worktree 里 `npm link` 新包，跑各自 typecheck / 单测；`grep -rn "pi-terminal-mux/" 两仓 src` 确认无 subpath 导入依赖（已知结论：均只 import 包根，F-005 已核实）；验证后解除 link 恢复 registry 安装。
- **Acceptance**：PiExtensions `npm run check --workspaces` 全绿；submodule 116/116。
- **Verification**：上述命令输出。

## 依赖与排序

U1 → U2 → U3 严格串行（同文件大改，不可并行）。U2 完成后必须先跑导出 diff 再进 U3。

## 风险

| 风险 | 缓解 |
|------|------|
| 循环 import（backend ↔ surface） | D1 单向依赖；typecheck 会立刻暴露 |
| 导出符号遗漏（`export *` 链断裂） | 基线导出快照 + diff 脚本逐符号比对 |
| 模块级状态（headlessProcesses/cmuxSubagentPane）被复制成两份 | 每个状态只许一个归属模块；grep 验证 |
| 测试隐含依赖 mux.ts 路径 | 测试只从 src/index.ts import，已核实 |

## 已知残余风险（doc-review 裁决记录）

- **F-003（P1，接受为残余）**：统一 surface API 派发从 switch 改为注册表查表，现有单测不覆盖派发本身。缓解：`Record<MuxBackend, BackendOps>` 全键填充由 TS 编译期强制；查表逻辑单行；U3 消费仓 116+ 测试实际跑过 createSurface/sendCommand 等真实路径作为行为安全网。不新增公开导出仅为可测性服务（R3 禁止新增符号）。
- **F-005/F-006**：已通过 D0 barrel 决策 + 基线快照（`/tmp/mux-exports-baseline.txt`，81 符号，已生成）解决。

## 执行期延后项

- 若 U2 中发现某 backend 与统一 API 耦合过深（如 zellij lock 横跨 create/rename），允许在该 backend 文件内保留辅助函数而不强行套 BackendOps，记录为 residual。
