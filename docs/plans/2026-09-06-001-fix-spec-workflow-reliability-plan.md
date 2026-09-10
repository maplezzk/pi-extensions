# Spec 工作流可靠性与阶段上下文改进

- Mode: lightweight
- Status: 实现完成；全仓检查与确定性 Pi RPC/TUI 验收通过，真实模型及人工验收未运行
- 仓库：公开 pi-extensions
- 工作区：`/Users/zzk/GitWorktree/public-pi-spec-mode/pi-extensions`
- 分支：`feat/public-pi-spec-mode`
- 研究基线：`c8e4dc2`（执行前重新核实远程和本地差异）
- 参考：https://x.com/FradSer/status/2095223249705828852

## 目标与边界

用户要求借鉴文章改进公开仓 spec 插件。本计划优先让已有状态、审批和恢复可靠，再把阶段方法按需加载；不是重写通用工作流框架。

用户最初要求更名为 `pi-spec`。npm 核查发现该名称已由 victormilk 发布 0.1.0；用户明确选择 npm 包名 `@maplezzk/pi-spec`，展示名和包目录仍为 `pi-spec` / `packages/pi-spec`。发布前另验证 scope 权限，本轮不发布；下文已有代码路径是迁移前的定位路径，命名任务完成后其余任务统一使用新路径。

保留 `/spec`、`spec_submit`、strict/quick 和现有文档阶段。quick 接受 requirements/design 仍标记 accepted-by-profile，不冒充人工审批；tasks/verification 仍需明确人工批准。

不做：自动判断所有请求是否需要 spec、引入 route DSL、自动启动子代理、模型切换、跨分支复制文档、自动发布/切换本机安装。未激活 spec 时不干预普通任务。

## 已核实的现状

以包内 `src/index.ts`、`state.ts`、`policy.ts`、`skills/spec-mode/SKILL.md` 和 README 为依据：

| 已有能力 | 实际缺口 |
| --- | --- |
| phase/status/revision 状态机、strict/quick | 不需要再增加一套阶段状态 |
| submit 记录 SHA，approve 校验文档，revise 清下游批准 | approve 只在异步 confirm 之前检查 SHA；确认期间的文件变化未再次检查 |
| 上游哈希失效回退 | 仅 before_agent_start 检查，未覆盖每个关键操作；verification 不在已批准哈希检查范围 |
| session custom entry 保存 activeSlug/toolsBefore/lastRevision | 实际业务状态来自共享 state.json；分支记录不是历史状态快照。恢复目标丢失/损坏时可能残留旧内存状态 |
| state.revision 写入前校验 | 内存先更新再落盘，落盘失败可能留下未提交内存状态；当前 revision 检查加 rename 不应声称是跨进程事务锁 |
| completedTasks 与 DONE 标记 | UI/执行指引反复扫描整个分支历史，旧规格/旧修订同名 TASK 的标记可能重新算完成 |
| 执行阶段可更新 tasks.md | 整篇 tasks.md 又绑定审批哈希，普通进度编辑也会触发审批失效 |
| 每轮注入简短 guidance | 未自动加载当前阶段方法正文，仍依赖全局 skill；skill 的“禁止 bash”等规则与实现/验证阶段实际权限矛盾 |
| 阶段工具集切换 | spec_submit 初始注册后未明确按 inactive/drafting/waiting 控制；恢复原工具快照可能覆盖其他扩展期间的调整 |

以上为只读代码发现，尚未通过回归测试复现；执行任务需先补相应回归。

## 设计决定（本计划建议，供审阅）

1. **一个规格一份磁盘真相。** 保留 `.pi/specs/<slug>/state.json` 为当前项目规格状态；session entry 保存当前分支选中的规格，不把树导航实现成磁盘文档/审批回滚。磁盘 revision 更新应明确提示，不静默恢复过期审批。独立历史执行需要独立 slug/worktree，本轮不做。
2. **批准绑定确认时的版本。** 进入确认时捕获 slug、phase、revision、提交 SHA；确认返回后重新读取当前状态和文档，上游失效或身份变化均拒绝此次批准。状态只有成功落盘后才更新内存/UI。
3. **任务定义和进度分开。** tasks.md 是批准过的执行契约；实现阶段不再通过 write/edit 修改它。进度写在插件管理的 completedTasks，仍接受本轮新产生的 DONE 标记，不将标记当测试通过的证据。修改任务必须 `/spec revise tasks`。
4. **方法正文与全局技能注册分开。** 当前阶段正文放包内双语 procedure 资源，运行时按阶段加载；保留最小操作技能入口，不把各阶段注册成全局 skills。不是单纯把全文从每轮 system prompt 搬到不断累积的 custom message。
5. **有界的状态约束。** 关键操作检查当前磁盘状态与批准指纹；不把 bash 和任意自定义工具限制包装为操作系统沙箱。本轮不建立通用工具能力分类，也不承诺多个进程同时审批的完整事务隔离。

### Simple Design

- expected_behavior：批准不落到错误版本，恢复不沿用旧上下文，进度不串规格/修订，当前阶段说明自动可用。
- concepts：规格状态、文档版本、任务进度、session 激活记录、阶段方法。
- reuse_decisions：`state.ts` 状态转移与失效规则属于 same_concept，继续复用；磁盘读取/校验/提交属于 shared_mechanism，可抽到 `storage.ts`；方法加载不放进校验器 `artifacts.ts`，由 `context.ts` 负责。
- prefactor：仅在对应任务中抽取 storage/context 边界，配入口事件测试，不新增泛化 workflow runtime。
- constraints：双语消息和 prompt；无私有路径/服务绑定；所有错误、冲突与恢复失败明确报告；不吞异常后继续执行。

## Plan Tasks

所有 Task 初始 `todo`。Write scope 为仓库相对路径；实现过程中发现范围变化先更新计划。

### TASK-package-rename · 插件以 @maplezzk/pi-spec 名称安装和使用

- **Status:** done
- **Depends on:** none
- **Write scope:** `packages/pi-spec-mode/**`；`packages/pi-spec/**`；`package.json`；`package-lock.json`；`release-please-config.json`；`.release-please-manifest.json`；`README.md`；`README.zh-CN.md`；`AGENTS.md`；`.github/workflows/release.yml`；`docs/plans/2026-09-06-001-fix-spec-workflow-reliability-plan.md`
- **Shared effects:** workspace 包名和目录、lockfile、发布登记、包校验脚本及引用。
- **Goal:** 公开插件统一使用 npm 包名 `@maplezzk/pi-spec`，不留下两个同时注册的插件包。
- **Acceptance:**
  - [x] 包名为 `@maplezzk/pi-spec`，目录为 `packages/pi-spec`，安装示例为 `pi install npm:@maplezzk/pi-spec`。
  - [x] 更新包元数据、双语文档、操作技能标识、workspace/发布登记和有效引用；历史文档无需批量改写。
  - [x] `/spec`、`spec_submit` 与 `.pi/specs/` 保持不变。
  - [x] 已有 state schema `pi-spec-mode/v1` 和 session entry `spec-mode` 保持可读；本次更名不顺带迁移持久化协议。
  - [x] 实施前核实旧包是否已发布；若已发布，记录旧用户安装迁移方式，不擅自撤包或发布兼容空包。
  - [x] 打包及包校验通过，无旧新包重复注册；不自动修改本机安装配置。
- **Approach:** 使用 Git 跟踪的目录迁移并更新有效引用；搜索确认 scripts 无旧名引用，发布 workflow 的 matrix 有目录引用，因此写入范围收窄为 `.github/workflows/release.yml`。完成后同步本计划其余任务路径和验证命令。
- **Verification:** `npm run check -w @maplezzk/pi-spec`、全仓包登记校验、`npm pack --dry-run`，旧规格与会话恢复回归。
- **Result:** 已迁移目录和 npm 元数据为 @maplezzk/pi-spec，更新发布 matrix/登记、双语安装说明及配置技能名，保留 v1 schema 与 spec-mode session key。旧 pi-spec-mode npm 404；新 scope 包查询也为 404，权限留到发布时验证。包 check 66/66、打包、12 包登记与 git diff --check 通过。npm install 报告 5 个依赖漏洞（2 moderate、3 high），未自动升级。完整恢复回归在后续任务补充。

### TASK-version-safe-approval · 批准只对当前确认版本生效

- **Status:** done
- **Depends on:** TASK-package-rename
- **Write scope:** `packages/pi-spec/src/index.ts`；`packages/pi-spec/src/state.ts`；`packages/pi-spec/src/storage.ts`；`packages/pi-spec/test/state.test.ts`；`packages/pi-spec/test/runtime.test.ts`；`packages/pi-spec/test/helpers/**`；`packages/pi-spec/locales/**`
- **Shared effects:** 入口事件、状态持久化、共享测试宿主、i18n catalog。
- **Goal:** 从提交到批准及后续执行均不使用过期文档版本。
- **Acceptance:**
  - [x] confirm 等待期间修改/删除当前文档、修改上游或切换规格，旧确认不得批准新状态。
  - [x] submit、approve、revise、continue 和受控写入/执行之前读取并核实状态；校验失败不继续原操作。
  - [x] verification 批准后的修改/删除也会使 complete 失效。
  - [x] revision 冲突、磁盘读取/写入失败不把尚未落盘状态展示为成功；错误明确可见。
  - [x] strict/quick 既有审批边界不变。
- **Approach:** 统一“读取当前有效状态—验证操作前提—计算候选—保存—更新内存/UI”的处理顺序；异步确认使用版本快照并在返回后复查；临时文件避免跨写者共用固定名称。保留 v1 读取兼容，不伪造缺失的批准记录。
- **Verification:** 包级状态/入口测试，用可控 confirm Promise 模拟等待期间文件变化、规格切换、revision 漂移和保存失败；检查没有成功通知或权限提前放开。
- **Result:** 新增真实入口事件回归，先复现 7 个失败后修复；补充保存失败与损坏磁盘测试。确认前后核对激活 epoch/slug/阶段/revision/SHA，关键操作刷新并检查全部文档指纹，保存成功后才更新候选内存，独立临时文件写入。包 check 75/75、类型检查与打包通过。完整状态结构验证、恢复失败阻断属于下一 Task；跨进程事务锁不在范围。

### TASK-reliable-session-restore · 恢复目标正确且工具权限不残留

- **Status:** done
- **Depends on:** TASK-version-safe-approval
- **Write scope:** `packages/pi-spec/src/index.ts`；`packages/pi-spec/src/storage.ts`；`packages/pi-spec/src/policy.ts`；`packages/pi-spec/test/runtime.test.ts`；`packages/pi-spec/test/policy.test.ts`；`packages/pi-spec/locales/**`；`packages/pi-spec/README.md`；`packages/pi-spec/README.zh-CN.md`
- **Shared effects:** session 生命周期、active tools、入口事件与 catalog。
- **Goal:** reload/树导航/重新激活后，UI、工具、激活规格与当前磁盘状态一致。
- **Acceptance:**
  - [x] 切到没有 spec entry 的分支时清除原激活状态，不沿用旧规格。
  - [x] entry 中 slug 非法、目录缺失、state 损坏时清掉旧业务状态；报告恢复失败并阻止本次工作流继续，不静默以普通模式执行原任务。
  - [x] 恢复完成前检查批准指纹；磁盘版本变化提示使用的是新磁盘状态，而不是历史审批。
  - [x] stop、重复 reload、连续树导航幂等，不恢复未知/已注销工具。
  - [x] 未激活或非 drafting 阶段不主动暴露 spec_submit；drafting 可用。直接误调用仍由运行时拒绝。
  - [x] 工具恢复只撤销 spec 自己的限制，不用整个旧快照覆盖其他扩展新增工具；同名工具被其他扩展同时改动的归属歧义需明确测试和文档说明。
- **Approach:** 先解析并验证候选激活上下文，再整体替换当前上下文；失败状态显式可恢复（use/stop），不保留上一个规格的授权。以插件自有工具策略的增减管理 active tools，先核对当前 Pi API 与 tool-display 组合行为。
- **Verification:** 入口宿主测试覆盖两个分支、两个 slug、损坏/缺失文件、重复事件与另一扩展增减工具；真实 Pi 恢复场景放在 E2E。
- **Result:** 已先复现 13 个状态/恢复缺口并修复；完整 v1 形状和审批链校验、损坏恢复显式阻断、use/stop 恢复、当前指纹检查、工具差量与注册列表过滤均已覆盖。补充其他扩展增删与同名歧义测试及双语说明。包 check 92/92、类型与打包及 diff 检查通过；真实 Pi 恢复验收留到 E2E。当前 Pi 的 new/resume 通过 session_start 事件通知，无独立 session_switch 监听需求。

### TASK-revision-scoped-progress · 任务进度不串规格或修订

- **Status:** done
- **Depends on:** TASK-reliable-session-restore
- **Write scope:** `packages/pi-spec/src/index.ts`；`packages/pi-spec/src/state.ts`；`packages/pi-spec/src/policy.ts`；`packages/pi-spec/test/runtime.test.ts`；`packages/pi-spec/test/state.test.ts`；`packages/pi-spec/test/policy.test.ts`；`packages/pi-spec/locales/**`
- **Shared effects:** completedTasks、DONE 消费、状态、UI 与 catalog。
- **Goal:** 已批准任务定义稳定；进度只来自当前激活执行周期的新完成事件。
- **Acceptance:**
  - [x] UI、剩余任务和进入 verification 统一读取当前状态进度，不扫描整个历史分支并合并旧 DONE。
  - [x] 同名 TASK 在另一 spec 或 revise 之前完成，不让当前任务自动完成。
  - [x] 重复 DONE 幂等；未知 TASK 忽略但给出明确诊断；空任务不自动进入验证。
  - [x] assistant 在异步执行期间遇到 spec/revision 切换时，旧轮次 DONE 不写入新执行周期。
  - [x] 实现阶段任务文档不可直接修改，进度更新不再改变批准哈希；需调整定义时明确提示 revise。
  - [x] 实现全部完成转 verification 时保留可展示的本轮完成进度；从 requirements/design/tasks 回退则清理受影响进度。
- **Approach:** completedTasks 为进度真相；在 agent 生命周期捕获执行身份，turn_end 仅消费匹配身份的新标记。若必须新增执行周期字段，显式定义旧 state 兼容与缺失信息的提示，不从历史文本猜测补全。
- **Verification:** 入口测试走 approve tasks → DONE → revise → approve → 同名任务；规格切换、重复标签、多轮回复、reload 后不重复累计，并检查 tasks.md 哈希保持不变。
- **Result:** 先复现历史 DONE、revise 后迟到 DONE、恢复后旧 DONE 与 tasks 可写四个失败并修复。仅 completedTasks 为真相，before_agent_start 捕获 slug/revision/epoch，当前 turn_end 新标记按身份消费，自身写入同步 revision，agent_end 清理身份；重复幂等、未知任务警告，验证/完成保留进度，revise 上游清理。包 check 98/98、类型、打包和 diff 检查通过；真实模型 E2E 待执行。

### TASK-stage-local-guidance · 当前阶段自动获得准确的方法说明

- **Status:** done
- **Depends on:** TASK-revision-scoped-progress
- **Write scope:** `packages/pi-spec/src/index.ts`；`packages/pi-spec/src/context.ts`；`packages/pi-spec/procedures/**`；`packages/pi-spec/skills/**`；`packages/pi-spec/SKILL.md`；`packages/pi-spec/locales/**`；`packages/pi-spec/package.json`；`packages/pi-spec/README.md`；`packages/pi-spec/README.zh-CN.md`；`packages/pi-spec/test/context.test.ts`；`packages/pi-spec/test/runtime.test.ts`；`package.json`；`package-lock.json`；`docs/reviews/2026-09-06-spec-reliability-verification.md`
- **Shared effects:** prompt 注入、包打包清单、技能发现与 catalog；确有 manifest/lock 联动时先扩充 Write scope。
- **Goal:** 不用模型主动寻找全局 skill，也能按当前阶段正确工作；不每轮重复累积完整方法正文。
- **Acceptance:**
  - [x] requirements/design/tasks/implementation/verification 各自加载对应双语方法；进入、切换、恢复时可用，后续仅短状态提示。
  - [x] 阶段切换后旧阶段正文不作为当前指令继续生效；上下文压缩后若正文已丢失，按内容存在性补载，不仅依靠“曾加载”布尔值。
  - [x] 待批只提示等待或 revise；complete 提供完成提示，不再生成 complete.md。
  - [x] 方法与实际权限一致：计划阶段禁 bash，实现/验证按策略开放；quick 说明准确；待批要 revise 后编辑；tasks.md 只承载定义。
  - [x] 根操作 skill 保留最小发现信息，阶段正文作为普通资源打包，不继续全局注册重复流程 skill；旧 `/skill:spec-mode` 入口变化在 README 明示。
  - [x] procedure 缺失/读取失败明确阻塞当前阶段，不静默回退到泛化提示；未激活不注入正文。
- **Approach:** `context.ts` 管内容选择与上下文存在性，不管理审批。阶段正文只有一个双语真相源；优先替换扩展自己拥有的阶段上下文消息，而非更改用户/工具消息。实施前核对当前 Pi context、compaction 与动态工具 API，不以摘要提醒冒充方法正文。
- **Verification:** 上下文事件测试比较首轮/重复轮/阶段切换/压缩恢复的正文次数与内容；包级 `npm pack --dry-run` 核实资源包含且无重复全局技能；TUI/RPC E2E核对说明与权限。
- **Result:** 先复现 3 个 context 入口失败，修复后包 check 105/105；新增五阶段双语 catalog、context 消息去重/替换/补回、待批及完成独立提示、资源错误显式阻断。移除旧全局 spec-mode skill，只留最小 configure-pi-spec；打包确认五个 procedure 且无旧 skills 目录。全仓 1249 测试、类型与政策门禁通过。Pi 0.80.10 的真实 RPC + 本地确定性 provider 34 项检查通过（含重启和压缩）；真实 TUI PTY 6 项通过（含确认取消与 reload）。真实模型与人工审批未运行，详见验证记录。

## 依赖与并行

`TASK-package-rename → TASK-version-safe-approval → TASK-reliable-session-restore → TASK-revision-scoped-progress → TASK-stage-local-guidance`

这些任务共享 src/index.ts、入口宿主和 catalog，并且后续行为建立在可靠状态基础上，故本计划串行实现。不是为了流程形式增加依赖。按用户本会话要求由主 Agent 亲自处理，不默认派实现子代理。

## 验证策略

本计划不执行测试。实施时逐 Task 先复现缺口，再运行定向测试；所有 Task 完成后运行：

- `npm run check -w @maplezzk/pi-spec`（更名后的包）
- `npm run check`（全仓门禁；本次以独立 PI_CODING_AGENT_DIR 隔离宿主配置执行，1249 项通过。只读核实上游 121ada5 是 nested-skills 测试隔离修复；当前工作区门禁不含该包，无需合入其他分支，也未修改安装 clone 的 dirty lock）
- 双语 catalog 完整性、包内容检查、本机路径与 console 输出政策检查。

不以文档存在、提交成功或 DONE 标记证明规格质量/测试通过。

## E2E

- **E2E Required:** yes
- **Evidence publication:** 本地证据文件，当前非 Auto、不上传飞书。
- 使用独立临时项目、显式加载公开分支包；不覆盖用户真实配置或安装，不操作用户终端名称。
- strict：new → 分阶段写文档并 submit → 人工 approve → implementation → DONE → verification → submit/approve → complete。
- 审批确认等待中外部修改文档：拒绝旧批准，提示重新提交。
- quick：requirements/design 自动接受，tasks 人工审批仍不可跳过。
- revise tasks 后同名 TASK 不自动完成；修改定义要求重新提交审批。
- /reload、重新启动、树导航至无 spec 分支和另一个 spec 分支，核对激活目标、磁盘 revision、工具及阶段说明；删除目标文件验证明确失败。
- 压缩前后检查当前 procedure 可用且无重复堆积；inactive 与 waiting 不向模型暴露 spec_submit。
- RPC 记录状态、事件及工具拒绝；TUI 单独验证审批交互与 Widget。不以 RPC 冒充 TUI 验收。无真实模型验证时明确 NOT_RUN，不声称提示词遵循率提升。

## 风险、兼容与停点

- 共享磁盘真相意味着树导航不回滚规格；这是明确保留的语义，不宣称完全分支隔离。若用户需要历史分支独立审批，另立范围讨论存储模型。
- 本轮修复操作期间可观测的版本漂移，不承诺外部进程在文件校验后任意时刻修改文件仍有操作系统级隔离。
- tasks.md 从可编辑进度改为冻结定义，以及流程 skill 改为按阶段资源，属于公开兼容变化，必须写迁移说明。
- 修改已完成 verification 将使完成状态失效；不能继续展示旧完成结果。
- 若当前 Pi API 无法可靠移除旧阶段上下文或判断正文是否丢失，先报告具体限制，不用“只加载一次”静默牺牲恢复正确性。
- 环境/宿主不可用时明确 blocked，保留证据，不追组件源码绕过问题。
- 用户已批准实现，并确认作用域包名；本轮不授权合并、发布或更换安装。
