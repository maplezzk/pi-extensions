---
name: configure-pi-clean-mode
description: 配置与排查 pi-clean-mode 的配置面板、折叠单位、耗时头、自动展开与快捷键。Use when configuring clean mode, opening its settings panel, or diagnosing collapsed transcript behaviour.
---

# 配置与排查 pi-clean-mode

`pi-clean-mode` 把一轮 agent 运行的工作过程折叠成一行耗时头，只留最终答案。折叠不是靠重新注册工具，而是替换 Pi 导出的对话组件原型方法。

## 交互与配置

路径：`<pi agent 目录>/extensions/pi-clean-mode/config.json`。

| 配置项 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后所有补丁放行原始渲染 |
| `autoExpandWhileRunning` | `true` | 执行中展开、运行结束后收起 |
| `showRunHeader` | `true` | 折叠时在最终答案上方显示 `用时 …` |
| `enableActionGroups` | `true` | 把一个 turn 的多条工具调用收成一行组头 |
| `showActivityArea` | `true` | 运行中显示实时活动块：顶部只留整轮时间与「处理中」，分类计数接在组头后面，细节行接在最新动作下面 |
| `activityRows` | `4` | 活动区高度，1-20 |
| `animateActivity` | `true` | 活动区动画；关闭后只保留静止标记 |
| `hideThinking` | `true` | 把 Pi 的 thinking 块从消息里抽掉（不是开 Pi 自己的隐藏开关，那个会留一个空行） |
| `hideExtensionEntries` | `true` | 折叠时连扩展写入的条目一起收起；通知提示始终可见 |

改配置：`/clean config`（或直接 `/config:clean-mode`）打开交互式面板，`↑`/`↓` 选、`enter`/`space` 切换、`esc` 关闭；活动区行数会再开一层 1-20 的列表（超出 8 项时列表自己滚动）。面板里每改一项立刻落盘并生效。

不开面板时也可以用 `/config:clean-mode showRunHeader=off`，或直接编辑文件后重启会话。

Pi 自带的 `/settings` 没有扩展注册配置项的入口，所以面板由扩展自己用 `ctx.ui.custom` + Pi 的 `SettingsList` 实现（`src/config-panel.ts`）；可写字段统一在 `src/config-fields.ts`，命令与面板共用同一套写回逻辑。

切换折叠：`f2` 或 `/clean` 收起/展开整轮；`shift+f2` 批量展开/收起全部动作组；全屏模式（`pi --tui-mode fullscreen`）下还可以鼠标点击耗时头或组头。

排查用调试日志：`PI_CLEAN_MODE_DEBUG=1 pi ...`，日志写在 `<pi agent 目录>/pi-clean-mode-debug.log`，包含事件（`message_end`/`tool_call`）与每条工具行的渲染决策（`normal`/`hidden`/`group-header`、组号与成员数）。

## 行为排查

| 现象 | 检查点 |
|---|---|
| 面板打不开 | 命令是否敲成 `/clean config` 或 `/config:clean-mode`；非 TUI（`pi -p` 等非交互模式）下 `ctx.ui.custom` 不可用，只能用 `key=on/off` 形式改配置 |
| 折叠后什么都没了 | `autoExpandWhileRunning` 是否被关掉，导致运行中也不显示；确认 `agent_settled` 能正常触发 |
| 运行中收起后整屏空白（其实还在跑） | 轮首槽位（`AssistantMessageHost` 的折叠头子组件）不能被耗时当开关：运行中 `runDurationMs` 还没写入，`resolveAssistantMessageRender` 的 `showHeader` 判 `durationMs !== undefined` 就会让槽位连同「处理中 · Ns」状态横条一起消失，而活动块同时被收起态隐藏，屏幕上就一条信息都没有。槽位是否输出只看「是不是本轮承载者」，里面画状态横条、耗时横条还是空行由 `createRunHeaderComponent` / `resolveRunHeader` 决定 |
| 运行结束后没有自动收起 | 本轮是否手动切换过 —— 手动切换会压制本轮自动收起，这是预期行为；否则检查 `agent_settled` 是否触发、TUI 句柄是否取得 |
| 耗时头上方太挤或下方空太多 | 耗时头子组件应输出「空行 + 耗时头」两行；下方间距由内容容器自带的 Spacer 提供，不要再加尾随空行 |
| 鼠标点不动 | 是否全屏模式；常规模式终端自己接管鼠标，Pi 收不到点击 |
| 收起态点不动耗时头 | 收起态是否绕过了容器渲染：`Container` 在 `render` 里登记每个子组件的高度，鼠标命中靠这份表算坐标；跳过就会沿用旧表，点击被派发到正文子容器上（见 `component-patches.ts` 的 `refreshContainerMouseLayout`） |
| 多条工具调用没有收成组头 | `enableActionGroups` 是否为 on；这些调用之间是否夹了解说（夹了就会断开成两组）；同组只有一条时不折叠 |
| 组头文案里的步数不对 | 检查 `turn_start` 是否每轮都触发，以及 `tool_call` 是否带上了 toolCallId |
| 组头永远是「探索 · N 步」 | 主词按组内**过半分类**选（`getGroupActivityLabel` → `dominantActivityClass`）。没传 `activity`（分类）或没有哪一类过半时就退回通用词，这是预期行为不是 bug；分类由 `registerActionToolCall` 的 `activity` 字段按组累加 |
| 折叠后最终答案不见了 | 该消息是否被判定成「带 tool call」。`stopReason === "length"` 的截断回复可能含未完成的 tool call，从而被当作工作过程隐藏 |
| 耗时头不显示 | `showRunHeader` 是否为 on；`runDurationMs` 是否为空（缺少 `agent_start` 时无耗时） |
| 活动区不显示 | `showActivityArea` 是否为 on；快照是否 `active`（未运行时不显示）；该轮是否已认领轮首承载者（本轮第一条 assistant 消息），或当前组是否存在；`isCurrentActionGroup` 是否取到当前状态 |
| 活动区一直停在顶部，不跟着最新动作走 | 活动块应接在当前组最后一条可见行末尾（`appendActivityTail`）。卡在顶部说明轮首还在读 `getActivityLines`（它只应读 `getRunStatusLines`），或当前组号对不上（`beginActionGroupStep` 是否在 turn 边界调了） |
| 顶部又出现思考或工具行 | 轮首子组件必须读 `getRunStatusLines`（`runtime.activityArea.runStatusLines`，无计数的状态行），不能读 `getActivityLines`；顶部只承担整轮时间，细节行只属于列表末尾 |
| 屏幕上出现两个「处理中」 | 只有轮首能写 `activityWorking` / `activityParallel`（`buildRunStatusLines`）。活动块里只能放思考、动作、输出尾巴；把状态文案或耗时再写一遍就是同一句话重复，对应断言在 `tests/activity.test.ts` 的「活动块只报最新状态」 |
| 分类计数又单独占一行 | 计数应接在组头 chip 后面（`buildActionGroupHeaderRow` + `getActivityCounters`），不另开一行。单独一行时它和组头的「N 步」在数同一件事 |
| 同一个动作名出现两次 | 单条组的组头就是这条动作的摘要，活动块要走去掉动作名的形态（`runtime.activityArea.detailLines` ← `withoutActionRows` 去掉 `actionRows` 那几行）。动作名到活动块里再列一遍，屏幕上就是同一句话两次 |
| 历史组的组头也带计数 | 计数是本轮累计值，只能加在当前组上（`isCurrentActionGroup`）；忘了这个判断就会给历史组报出不属于它的数字 |
| 活动块悬在组中段 | `appendActivityTail` 的「最后一条可见行」算错了：展开的组是 `groupSize - 1`，收起时是 `0`（成员行隐藏，只剩组头）；写成固定 0 就会挂到组头上、展开后看起来悬在中间 |
| 发送后一段时间没任何反馈，看着像卡住 | 活动行要等一个能挂它的组件：轮首槽位属于本轮第一条 assistant 消息（`message_start` 才创建），组头则要等第一个工具调用。这段窗口里绝对不能关 Pi 自带的 Working 提示，否则屏幕一片空白。判定在 `ActivityAreaDeps.hasRunHeaderHost`，它也参与去重签名 |
| 活动区闪或卡 | 检查是否绕过了内容签名去重而每次 tick 都请求重绘；行内容不变时必须跳过 |
| 活动区结束后还残留 | `agent_settled` / `session_shutdown` 是否调到了 `clearActivityArea`（它会清空 `runtime.lines` / `detailLines` / `rows` 与 `runtime.runStatusLines` 并请求一次重绘） |
| 活动区行没底色 | 只有轮首那条运行级横条铺底色（`bandActivityHead` + `styler.band`），活动块里的行本来就不铺；主题缺 `customMessageBg` 时 `band` 会退化成纯文本补齐 |
| 活动区行没对齐 / 竖折没出来 | 前缀常量在 `activity.ts` 顶部：横条文案用 `BAND_INDENT`，活动块的竖折用 `TREE_INDENT` + `├─` / `└─`（`renderActivityRows` 按「后面还有没有子项」选分支符）。截断或去掉动作行之后必须用 `renderActivityRows` 重拼一次，直接沿用上一轮拼好的字符串就会收口错（最后一行还挂 `├─`） |
| 活动区显示一堆 `*` | 思考头部的成对强调符由 `stripEmphasisMarkup` 剥掉；若某条消息直接写快照而不经过 `extractThoughtHead`，就会绕过它 |
| thinking 原文还在刷屏 | `hideThinking` 是否为 on；它靠 `resolveRenderedMessage` 在 `updateContent` 前抽掉 thinking 内容块，若某条消息看不到效果，检查该消息是否只走了 `render` 而没走 `updateContent` |
| 折叠完全无效 | Pi 版本是否仍导出 `AssistantMessageComponent` / `ToolExecutionComponent` |
| 清爽模式下仍有裸露的扩展行（如 `Distill` 审计行） | 该行是 `pi.appendEntry` 写的 custom entry，不在两个导出组件里。检查 `hideExtensionEntries` 是否为 on（默认 on）；条目是否在「工作窗口」内产生 —— 运行期间，或 `session_start` 后的恢复窗口；运行结束后才出现的条目不折。若两者都成立仍不隐藏，看 Pi 的 `CustomEntryComponent` 特征是否变了（本扩展靠「同时持有 entry / renderer / hasContent」识别），或该条目被注册成了 `pi-extensions-notice`（通知豁免，不折） |
| `/resume` 或 `/reload` 后整段历史原样铺开 | `session_start` 是否调了 `restoreHistory`：历史消息不重放 `agent_start` / `agent_settled`，状态会停在 `createInitialState()` 的展开态，折叠就失效。注意即使收起，历史轮次也不会出现耗时横条 —— 耗时与步数只存在内存里，不写进会话 |
| `session_start` 到底拿到的哪个 reason | 调试日志里记了 `reason=startup\|reload\|new\|resume\|fork` 与处理后的 `collapsed` |

## 折叠后的视觉层次

三级用不同视觉，不能和正文混在一起（`src/header-style.ts` 负责）：

| 层级 | 视觉 |
|---|---|
| 运行级折叠头 | 整行铺满底色的横条（`customMessageBg`）+ 行首 `[clean]` 来源前缀 + 紧跟在文案右边的强调色箭头 |
| 动作组头 | 与折叠头**文案同列** + 行首 `[clean]` 来源前缀 + 只包住文字的底色标签（`toolPendingBg`）+ 紧跟其后的强调色箭头 |
| 正文 / 工具行 | 不铺底色；可见的工具行也会在首行尾部加同款箭头（`insertToolRowArrow`） |

来源前缀在 `src/source-tag.ts`（`PREFIX_TAG`）里只定一次，提示来源 tag 与自绘块前缀共用。两级折叠头都带前缀，所以两者文案仍然同列（列数 = 缩进 + 前缀宽 + 一个空格），改前缀只影响一处。

箭头用实心三角 `▶`（收起）/ `▼`（展开），宽度按 `visibleWidth` 算；插到已有工具行上是「用箭头替掉尾部的填充空格」，保证行宽不变。折叠头不再显示 `f2` 快捷键提示（`f2` 本身仍然可用，只是不占用横条）。

组内只有一条时标签直接用该动作的摘要（`toolActivityLabel` + `toolActivityDetail`），多条才用 `actionGroupHeader` 计数文案。主题缺色时 `createHeaderStyler` 在构造时探测并逐项退化成纯文本，渲染路径上没有 try/catch；横条的截断/补齐仍由 `truncateToWidth(..., pad)` 保证。

## 实时活动区的四条约束

改动 activity.ts / activity-area.ts / component-patches.ts 时必须遵守：

1. 行内容不变就完全不请求重绘 → 先把行拼成字符串比较签名，不变就直接返回；
2. 运行期间活动块行数只增不减（不足用空行补齐），否则内容高度会反复拖动下方内容；
3. 动画 150ms 一帧（关闭动画 1000ms），定时器 `unref()`，且只在运行时存在；`agent_settled` 立即停掉并清空 `runtime.lines`。
4. 思考动画帧只用「每帧单格宽、墨量恒定、只变朝向」的字符：当前是 `◐◓◑◒`（四个方向各半填充，顺时针转，四帧一循环）。不要用盲文单点（`⠁⠂⠄⡀⢀⠠⠐⠈` —— 一个孤点在深色底上像噪点），也不要用 `◌◔◕●` 这类改变填充比例的图形（视觉上会被读成忽大忽小）。

活动块的位置：接在当前组**最后一条可见行**的末尾（`appendActivityTail`）—— 展开的组接在末位成员下面，收起时成员行整行隐藏、接在组头下面，所以最新状态永远在列表最底部，不会悬在中段。轮首折叠头子组件（`createRunHeaderComponent`）只输出运行级时间（`buildRunStatusLines`：在处理 + 耗时，无计数），思考与工具细节一概不往顶部搬。两处共用 `runtime.activityArea.lines` / `runStatusLines` 与 `bandActivityHead`，且都只认「当前组」（`isCurrentActionGroup`）与「当前轮承载者」（`isCurrentRunHost`），所以历史轮次不会重复显示。运行结束后活动行清空，轮首位置换成 `用时` 横条（耗时在 `agent_settled` 才写入，两者不会同时出现）。

分工与去重（屏幕上只有一条横条，一个动作名只说一遍）：**「处理中」（或并行文案）与耗时只在轮首出现一次**（`buildRunStatusLines`），活动块里全是思考、动作、输出尾巴这类普通行，不铺底色、行首带 `├─` / `└─` 竖折；**分类计数也不单独占行**，它接在当前动作组的组头 chip 后面（`formatActivityCountersSuffix` → `getActivityCounters`，只给当前组）；**组头主词**按组内过半分类选（`dominantActivityClass` → `activityClassLabel`，经 `getGroupActivityLabel` 交给渲染层），没有过半分类时退回通用词 `探索 · N 步`；**组内只有一条时活动块去掉动作名**：`buildActivityLines` 返回结构化行 `rows` 与 `actionRows`（哪几行在报「正在跑什么」），`activity-area.ts` 先把 `rows` 补齐再渲染出完整形态 `lines` 与去掉动作名的 `detailLines`（`withoutActionRows` 过滤后用 `renderActivityRows` 重拼前缀），`appendActivityTail` 按组大小取形态。活动块的位置见上一段。缩进常量在 `activity.ts` 顶部（`BAND_INDENT` 是横条文案、`TREE_INDENT` 是活动块竖折），运行级横条与运行结束后的「用时 …」同列，因此状态切换不跳列。

## 边界

- 折叠单位是 `agent_start` → `agent_settled` 的整次运行；动作组的边界跟着解说走（带正文的 assistant 消息开新组，连续纯工具 turn 合并）。
- 组内只有一条时不折叠，直接显示该工具行本身。
- 耗时头在折叠态与展开态都显示，这样两个方向都有可点击的鼠标目标。
- 运行中手动收起（鼠标点轮首横条、`f2` 或 `/clean`）只收起工作过程与活动块，**轮首的「处理中 · Ns」状态横条继续显示**：它是运行结束前唯一能说明「还在跑」的信息，跟着收起就变成整屏空白。槽位是否输出不看耗时（`resolveAssistantMessageRender`），看的是它是否为本轮承载者。
- 组状态与运行状态独立；展开整轮后各组保持原有收放状态。
- 会话重新加载后历史行不会恢复分组（组号与成员表在内存里），它们会逐条正常显示。
- 原型补丁在 reload / shutdown 时还原；若安装后原型被其它扩展替换，本扩展不会顶掉对方的实现。
- 与重新注册工具类的扩展（例如 `pi-extensions-tool-display`）不冲突：本扩展不调用 `pi.registerTool`。
- 扩展条目折叠（`src/extension-entry-patch.ts`）补丁的是 pi-tui 的 `Container.prototype.render`：Pi 没导出 `CustomEntryComponent`，只能按结构特征认。只折工作条目（运行期间 + 会话恢复窗口），通知条目（`NOTICE_ENTRY_TYPE`）始终豁免。
