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
| `showActivityArea` | `true` | 运行中显示实时活动块，跟着当前动作组头走（无组头或收起时回落轮首） |
| `activityRows` | `4` | 活动区高度，1-20 |
| `animateActivity` | `true` | 活动区动画；关闭后只保留静止标记 |
| `hideThinking` | `true` | 把 Pi 的 thinking 块从消息里抽掉（不是开 Pi 自己的隐藏开关，那个会留一个空行） |

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
| 运行结束后没有自动收起 | 本轮是否手动切换过 —— 手动切换会压制本轮自动收起，这是预期行为；否则检查 `agent_settled` 是否触发、TUI 句柄是否取得 |
| 耗时头上方太挤或下方空太多 | 耗时头子组件应输出「空行 + 耗时头」两行；下方间距由内容容器自带的 Spacer 提供，不要再加尾随空行 |
| 鼠标点不动 | 是否全屏模式；常规模式终端自己接管鼠标，Pi 收不到点击 |
| 收起态点不动耗时头 | 收起态是否绕过了容器渲染：`Container` 在 `render` 里登记每个子组件的高度，鼠标命中靠这份表算坐标；跳过就会沿用旧表，点击被派发到正文子容器上（见 `component-patches.ts` 的 `refreshContainerMouseLayout`） |
| 多条工具调用没有收成组头 | `enableActionGroups` 是否为 on；这些调用之间是否夹了解说（夹了就会断开成两组）；同组只有一条时不折叠 |
| 组头文案里的步数不对 | 检查 `turn_start` 是否每轮都触发，以及 `tool_call` 是否带上了 toolCallId |
| 折叠后最终答案不见了 | 该消息是否被判定成「带 tool call」。`stopReason === "length"` 的截断回复可能含未完成的 tool call，从而被当作工作过程隐藏 |
| 耗时头不显示 | `showRunHeader` 是否为 on；`runDurationMs` 是否为空（缺少 `agent_start` 时无耗时） |
| 活动区不显示 | `showActivityArea` 是否为 on；快照是否 `active`（未运行时不显示）；该轮是否已认领轮首承载者（本轮第一条 assistant 消息），或当前组是否存在；`isCurrentActionGroup` / `hasRunToolRows` 是否取到当前状态 |
| 活动区一直停在顶部，不跟着最新动作走 | 本轮已经有工具行时，活动块应由当前组的组头渲染（`buildGroupHeadLines`），轮首只在 `collapsed || !hasRunToolRows()` 时才画。卡在顶部说明 `hasRunToolRows` 恒为假（`runtime.runToolCount` 没被登记）或当前组号对不上（`beginActionGroupStep` 是否在 turn 边界调了） |
| 发送后一段时间没任何反馈，看着像卡住 | 活动行要等一个能挂它的组件：轮首槽位属于本轮第一条 assistant 消息（`message_start` 才创建），组头则要等第一个工具调用。这段窗口里绝对不能关 Pi 自带的 Working 提示，否则屏幕一片空白。判定在 `ActivityAreaDeps.hasRunHeaderHost`，它也参与去重签名 |
| 活动区闪或卡 | 检查是否绕过了内容签名去重而每次 tick 都请求重绘；行内容不变时必须跳过 |
| 活动区结束后还残留 | `agent_settled` / `session_shutdown` 是否调到了 `clearActivityArea`（它会清空 `runtime.lines` 并请求一次重绘） |
| 活动区首行没有底色横条 | 首行的底色由 `component-patches.ts` 的 `bandActivityHead` 铺上（`styler.band`），轮首子组件与组头（`buildGroupHeadLines`）都要走它；主题缺 `customMessageBg` 时 `band` 会退化成纯文本补齐 |
| 活动区行没对齐 | 首行与运行级横条同列（`BLOCK_INDENT`），细节行 `DETAIL_INDENT`、输出尾巴 `OUTPUT_INDENT`；三者在 `activity.ts` 顶部 |
| 活动区显示一堆 `*` | 思考头部的成对强调符由 `stripEmphasisMarkup` 剥掉；若某条消息直接写快照而不经过 `extractThoughtHead`，就会绕过它 |
| thinking 原文还在刷屏 | `hideThinking` 是否为 on；它靠 `resolveRenderedMessage` 在 `updateContent` 前抽掉 thinking 内容块，若某条消息看不到效果，检查该消息是否只走了 `render` 而没走 `updateContent` |
| 折叠完全无效 | Pi 版本是否仍导出 `AssistantMessageComponent` / `ToolExecutionComponent` |
| `/resume` 或 `/reload` 后整段历史原样铺开 | `session_start` 是否调了 `restoreHistory`：历史消息不重放 `agent_start` / `agent_settled`，状态会停在 `createInitialState()` 的展开态，折叠就失效。注意即使收起，历史轮次也不会出现耗时横条 —— 耗时与步数只存在内存里，不写进会话 |
| `session_start` 到底拿到的哪个 reason | 调试日志里记了 `reason=startup\|reload\|new\|resume\|fork` 与处理后的 `collapsed` |

## 折叠后的视觉层次

三级用不同视觉，不能和正文混在一起（`src/header-style.ts` 负责）：

| 层级 | 视觉 |
|---|---|
| 运行级折叠头 | 整行铺满底色的横条（`customMessageBg`）+ 紧跟在文案右边的强调色箭头 |
| 动作组头 | 与折叠头**文案同列** + 只包住文字的底色标签（`toolPendingBg`）+ 紧跟其后的强调色箭头 |
| 正文 / 工具行 | 不铺底色；可见的工具行也会在首行尾部加同款箭头（`insertToolRowArrow`） |

箭头用实心三角 `▶`（收起）/ `▼`（展开），宽度按 `visibleWidth` 算；插到已有工具行上是「用箭头替掉尾部的填充空格」，保证行宽不变。折叠头不再显示 `f2` 快捷键提示（`f2` 本身仍然可用，只是不占用横条）。

组内只有一条时标签直接用该动作的摘要（`toolActivityLabel` + `toolActivityDetail`），多条才用 `actionGroupHeader` 计数文案。主题缺色时 `createHeaderStyler` 在构造时探测并逐项退化成纯文本，渲染路径上没有 try/catch；横条的截断/补齐仍由 `truncateToWidth(..., pad)` 保证。

## 实时活动区的四条约束

改动 activity.ts / activity-area.ts / component-patches.ts 时必须遵守：

1. 行内容不变就完全不请求重绘 → 先把行拼成字符串比较签名，不变就直接返回；
2. 运行期间活动块行数只增不减（不足用空行补齐），否则内容高度会反复拖动下方内容；
3. 动画 150ms 一帧（关闭动画 1000ms），定时器 `unref()`，且只在运行时存在；`agent_settled` 立即停掉并清空 `runtime.lines`。
4. 思考动画帧只用「每帧单格宽、墨量恒定、只变朝向」的字符：当前是 `◐◓◑◒`（四个方向各半填充，顺时针转，四帧一循环）。不要用盲文单点（`⠁⠂⠄⡀⢀⠠⠐⠈` —— 一个孤点在深色底上像噪点），也不要用 `◌◔◕●` 这类改变填充比例的图形（视觉上会被读成忽大忽小）。

活动块的位置跟随当前动作：本轮已经有工具行时，它插在当前组的组头上方（`buildGroupHeadLines`：前导空行 → 活动行 → 组头行），所以进度贴着最新动作；本轮还没有工具行、或运行级收起（工具行整行隐藏）时，回落到轮首折叠头子组件（`createRunHeaderComponent`）。两处共用 `runtime.activityArea.lines` 与 `bandActivityHead`，且都只认「当前组」（`isCurrentActionGroup`）与「当前轮承载者」（`isCurrentRunHost`），所以历史轮次不会重复显示。运行结束后活动行清空，轮首位置换成 `用时` 横条（耗时在 `agent_settled` 才写入，两者不会同时出现）。

活动块的版式（`activity.ts`）：第一行是状态横条（`处理中`/`并行执行` + 耗时 + 非 0 计数），由渲染方整行铺底色；后面依次是思考头部、正在执行的工具（并行逐条）与输出尾巴。三档缩进常量在 `activity.ts` 顶部（`BLOCK_INDENT` / `DETAIL_INDENT` / `OUTPUT_INDENT`），首行与运行级横条文案同列，因此状态切换不跳列。

## 边界

- 折叠单位是 `agent_start` → `agent_settled` 的整次运行；动作组的边界跟着解说走（带正文的 assistant 消息开新组，连续纯工具 turn 合并）。
- 组内只有一条时不折叠，直接显示该工具行本身。
- 耗时头在折叠态与展开态都显示，这样两个方向都有可点击的鼠标目标。
- 组状态与运行状态独立；展开整轮后各组保持原有收放状态。
- 会话重新加载后历史行不会恢复分组（组号与成员表在内存里），它们会逐条正常显示。
- 原型补丁在 reload / shutdown 时还原；若安装后原型被其它扩展替换，本扩展不会顶掉对方的实现。
- 与重新注册工具类的扩展（例如 `pi-extensions-tool-display`）不冲突：本扩展不调用 `pi.registerTool`。
