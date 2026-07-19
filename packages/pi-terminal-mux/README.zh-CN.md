# pi-terminal-mux

终端多路复用器统一抽象层，供 pi 扩展复用。任何涉及终端交互（分屏、发命令、读屏、关屏、等待退出）的插件都应依赖本包，而不是各自重新实现 backend 探测与命令拼装。

一套统一的 surface API 跨 **muxy、cmux、tmux、zellij、wezterm、herdr、otty** 七个后端，探测不到任何后端时自动降级为 **headless**（后台子进程 + 日志文件）。

[English README](./README.md)

## 安装

```bash
npm install pi-terminal-mux
```

## 快速上手

```ts
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  sendEscape,
  readScreen,
  closeSurface,
  pollForExit,
} from "pi-terminal-mux";

if (!isMuxAvailable()) {
  console.warn(muxSetupHint()); // 中英文安装提示，由 pi-extensions-i18n 决定语言
}

// 智能放置：按后端策略分屏 / 堆叠 / 开 tab（headless 时返回 headless surface）
const surface = createSurface("my-agent");

// 长命令自动落脚本文件，避免终端宽度截断
const scriptPath = sendLongCommand(surface, "pi --session abc", {
  scriptPreamble: "export MY_FLAG=1",
});

const tail = readScreen(surface, 50);
sendEscape(surface);
closeSurface(surface);
```

## 后端探测

| 后端 | 探测条件 |
|------|----------|
| muxy | `MUXY_SOCKET_PATH` + `muxy` 命令 |
| cmux | `CMUX_SOCKET_PATH` + `cmux` 命令 |
| tmux | `TMUX` + `tmux` 命令 |
| zellij | `ZELLIJ` / `ZELLIJ_SESSION_NAME` + `zellij` 命令 |
| wezterm | `WEZTERM_UNIX_SOCKET` + `wezterm` 命令 |
| herdr | `HERDR_ENV=1` + `HERDR_PANE_ID` + `herdr` 命令 |
| otty | `TERM_PROGRAM=otty` + `otty` 命令 |

默认优先级即上表顺序（muxy 优先）。可用环境变量强制指定后端：

- `PI_TERMINAL_MUX`（推荐）：`muxy | cmux | tmux | zellij | wezterm | herdr | otty`
- `PI_SUBAGENT_MUX`：同上的向后兼容别名

指定的后端运行环境不满足时 `getMuxBackend()` 返回 `null`，不会悄悄降级到其他后端。

## API 概览

### 统一 surface API（跨后端语义一致）

| 函数 | 说明 |
|------|------|
| `createSurface(name)` | 智能放置新 surface（cmux 首次右分屏后续开 tab、zellij tab 感知平铺/堆叠、muxy/otty 广度优先分屏），返回 surface 标识 |
| `createSurfaceSplit(name, direction, fromSurface?)` | 指定方向（left/right/up/down）分屏 |
| `sendCommand(surface, command)` | 发送命令并回车执行 |
| `sendLongCommand(surface, command, opts?)` | 长命令先写脚本文件再执行；`opts.scriptPreamble` 可注入 env export；返回脚本路径 |
| `sendEscape(surface)` | 发送一次 ESC |
| `readScreen(surface, lines?)` / `readScreenAsync` | 读取屏幕尾部 N 行 |
| `closeSurface(surface)` | 关闭 surface |
| `renameSurface(surface, name)` / `renameCurrentTab(title)` / `renameAgent(surface, name)` / `renameWorkspace(title)` | 命名（按后端能力降级或跳过） |
| `pollForExit(surface, signal, opts)` | 等待 surface 内进程退出：优先 `.exit` sidecar 文件，其次屏幕 sentinel（`__SUBAGENT_DONE_<code>__`），headless 走子进程 exit |
| `getLastSplitSource()` / `clearLastSplitSource()` | 最近一次分屏的来源 pane（用于 UI 展示） |

### 探测与工具

`getMuxBackend()`、`isMuxAvailable()`、`isHeadlessMode()`、`muxSetupHint()`、`getAgentPaneId(backend?)`、`backendAgentPaneEnvVar(backend)`、`shellEscape()`、`isFishShell()`、`exitStatusVar()`，以及 zellij 放置规划（`selectZellijPlacement` 等）与 cmux/otty JSON 解析等纯函数，均可直接引用做单元测试。

### 后端原生 API

各后端原生函数也从包入口透出（如 `createHerdrSurface`、`splitHerdrPane`、`readHerdrScreen`、`sendOttyCommand`、`renameOttyTab`……），子路径导入亦可：`pi-terminal-mux/mux`、`pi-terminal-mux/herdr`、`pi-terminal-mux/otty`。

## Headless 模式

探测不到任何后端时，`createSurface` 返回 `headless:` 前缀的 surface，`sendLongCommand` 直接 spawn 后台子进程并把输出写入日志文件，`readScreen`/`pollForExit`/`closeSurface` 语义保持不变，调用方无需特判。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PI_TERMINAL_MUX` / `PI_SUBAGENT_MUX` | 强制指定后端 |
| `PI_SUBAGENT_ZELLIJ_MIN_COLUMNS` / `PI_SUBAGENT_ZELLIJ_MIN_ROWS` | zellij 分屏最小可用尺寸（默认 50×10，不满足时改堆叠） |
| `PI_SUBAGENT_RENAME_TMUX_WINDOW` / `PI_SUBAGENT_RENAME_TMUX_SESSION` | tmux 下允许 renameCurrentTab / renameWorkspace（默认不动用户命名） |
| `PI_SUBAGENT_RENAME_HERDR_WORKSPACE` | herdr 下允许 renameWorkspace |
| `PI_EXTENSIONS_LOCALE` | 提示文案语言（`zh-CN` / `en-US` / `auto`），由 pi-extensions-i18n 提供 |

## 设计约束

- **不绑定具体机器**：全部后端通过运行时探测（环境变量 + 命令存在性）选择，零硬编码本机路径；外部 CLI 缺失时按后端逐个降级，最终落到 headless。
- **用户文案国际化**：面向用户的提示走 [pi-extensions-i18n](https://www.npmjs.com/package/pi-extensions-i18n) catalog，中英文齐全。
- **agent pane 锚定**：muxy/herdr/otty 的 agent 自身 pane ID 在模块加载时捕获（`AGENT_MUXY_PANE_ID` 等），不受用户后续焦点切换影响。

## License

MIT
