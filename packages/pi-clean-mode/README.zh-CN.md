# pi-clean-mode

`pi-clean-mode` 把一轮 agent 运行的完整工作过程折叠成一行耗时头，对话里只留最终答案。按快捷键（默认 `f2`）可以随时展开回看。

## 改变了什么

一次提问通常会让 agent 执行很多次工具调用、穿插好几段解说，最后才给出答案。Pi 默认把这些全部展示出来。本扩展把除最终答案之外的内容都视为**工作过程**并折叠：

```
[用户消息]

用时 4m 26s ›
原因查到了：今天补货用了两天前的旧销量，低估了需求，所以看起来只够约 10 天。
```

展开后工作行会回来，耗时头的箭头从 `›` 变成 `⌄`。

## 三级折叠

| 层级 | 行 | 行为 |
|---|---|---|
| 运行级 | `用时 4m 26s ›` | 收起整轮工作过程，只留最终答案 |
| 动作组级 | `▸ 探索 · 3 步` | 把一个 turn 的多条工具调用收成一行组头 |
| 工具行级 | `$ find . -name '*.ts'` | Pi 自带的单行输出展开（`ctrl+o`，或点结果区） |

组边界跟着**解说**走：带正文的 assistant 消息开新组，连续的纯工具 turn 合并进当前组。所以一串连续工作会读成一行 —— 即使模型每个 turn 只发一条工具调用（这是常态）。

组内只有一条时不折叠，直接显示那条工具行本身，所以单条命令仍然读起来就是它自己。

```
用时 11s ⌄
我会先核对补货数据。

▸ 探索 · 3 步                 ← 动作组收起

用时 11s ⌄
我会先核对补货数据。

  $ find . -name '*.ts'       ← 动作组展开
  $ wc -l src/*.ts
  $ git status
```

组状态与运行状态互相独立：展开整轮时，各组保持你上次留下的收放状态。

## 交互

| 触发方式 | 效果 |
|---|---|
| `f2` | 收起或展开本轮工作过程 |
| `shift+f2` | 展开或收起全部动作组 |
| 鼠标点击耗时头 | 同 `f2`，**仅全屏 TUI 模式** |
| 鼠标点击组头 | 单独展开或收起该动作组，**仅全屏 TUI 模式** |
| `/clean` | 同快捷键 |
| `/config:clean-mode` | 打印当前配置 |
| `/config:clean-mode <key>=on\|off` | 修改一个布尔配置并保存 |

鼠标需要 `pi --tui-mode fullscreen`；常规模式下终端自己接管鼠标输入与滚动，Pi 收不到点击。可点击区域是耗时头那行加上它上面的空行，点正文不会误触。

如果本轮运行中你自己切换过折叠状态，本轮结束后不会自动收起 —— 直到下一次运行开始都尊重你的选择。

## 工作过程与最终答案怎么区分

Pi 在扩展入口导出了对话组件，本扩展替换 `AssistantMessageComponent` 的 `render` 与 `updateContent`，以及 `ToolExecutionComponent.render`：

| 组件 | 折叠时的行为 |
|---|---|
| **带** tool call 的 assistant 消息 | 整条隐藏（解说属于工作过程） |
| **不带** tool call 的 assistant 消息 | 保留，并挂上耗时头 |
| 工具行 | 整行隐藏，或收成一行动作组组头 |

「不带 tool call 的消息就是最终答案」的依据是：agent 循环只有在一次回复不含 tool call 时才结束，所以一次运行里这样的消息只有最后那一条。

被隐藏的行渲染为 0 行，所以耗时头正好落在最终答案上方。耗时头本身是包了 `MouseRegion` 的真实子组件，而不是 render 里拼的字符串 —— 因为 Pi 的 `Container` 按子组件高度计算鼠标命中偏移。

## 运行时的行为

agent 执行期间保持展开 —— 否则折叠状态下用户在答案出现前会什么都看不到。运行结束（`agent_settled`）后自动收起。如果用户在本次运行中手动切换过状态，本次运行不再自动收起。

耗时头只在耗时已知后才出现，所以流式期间不会显示。

## 配置

配置文件路径：`<pi agent 目录>/extensions/pi-clean-mode/config.json`，示例见 `config.example.json`。

```json
{
  "enabled": true,
  "autoExpandWhileRunning": true,
  "showRunHeader": true,
  "showExpandHint": true
}
```

| 配置项 | 含义 |
|---|---|
| `enabled` | 总开关。关闭后所有补丁直接放行原始渲染。 |
| `autoExpandWhileRunning` | 执行中自动展开，运行结束后自动收起。 |
| `showRunHeader` | 在最终答案上方显示 `用时 …` 折叠头。 |
| `showExpandHint` | 在折叠头末尾附带展开提示。 |
| `enableActionGroups` | 把一个 turn 的多条工具调用收成一行组头。 |
| `showActivityArea` | 在编辑器上方显示实时活动区。 |
| `activityRows` | 活动区高度，1-6，默认 4。 |
| `animateActivity` | 是否播放动画；关闭后只保留静止标记。 |

## 调试

设置 `PI_CLEAN_MODE_DEBUG=1` 后，事件与渲染决策会追加写入 `<pi agent 目录>/pi-clean-mode-debug.log`。默认关闭，且开关只在进程启动时读一次，关闭时对渲染路径没有开销。

## 实时活动区

agent 运行期间，编辑器上方会显示一小块「现在在做什么」：

```
│ ◑ 思考  正在追踪 token 失效路径…
│ ⠹ 运行命令 npm test
│   ↳ 12 passing
│ 读取 4 · 搜索 3 · 命令 1 · 42s
```

内容全部来自真实事件 —— 正在跑的工具、它的最新输出行、思考头部、以及分类计数。并行调用会收成一行汇总。

两条实现约束是从 `pi-desktop-transcript` 处理同一问题的方式里学的：

1. **`ctx.ui.setWidget` 会重绘整屏。** 所以先把行渲染成字符串与上一 tick 比较，内容完全一致时**根本不调用** `setWidget`。
2. **动画压到 2.5fps（400ms）**，定时器只在运行时存在，并且 `unref()`。`animateActivity: false` 时降到 1s 并显示静止标记。

活动区在展示当前动作时会顺手隐藏 Pi 自己的 `Working...` 与隐藏思考块的占位文案，避免同一件事说两遍。

## 兼容性

本扩展替换 Pi 组件的原型方法，因此与 Pi 的组件导出面绑定（`AssistantMessageComponent.hasToolCalls`、`ToolExecutionComponent.render`，以及「空渲染等于 0 行」的行为）。它在 reload 与 shutdown 时还原原型，并且不会覆盖安装之后被其它扩展替换掉的原型。

选 `f2` 是因为 Pi 内置键位没有占用它。如果你改过 Pi 键位，请避免与它冲突。

## 安装

```bash
pi install npm:pi-clean-mode
```

## 开发

```bash
npm test
npm run typecheck
```

## License

[MIT](../../LICENSE)
