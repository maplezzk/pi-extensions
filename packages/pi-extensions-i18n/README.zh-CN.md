# pi-extensions-i18n

Pi 扩展公共国际化运行时。它提供基于 catalog 的小型 API，支持 `zh-CN`、`en-US` 和自动语言选择。

## 为什么需要公共包

独立的 Pi 扩展仍然需要相同的基础能力：可移植的配置路径、语言优先级、fallback、catalog 校验和参数插值。把这些能力集中在这里，功能包就可以专注于自身逻辑，同时保持用户可见文案的一致性。

## 能力

- 支持 `zh-CN`、`en-US` 和 `auto` 语言偏好。
- 将设置持久化到 `~/.pi/agent/extensions/pi-extensions-i18n/config.json`。
- 支持 `PI_EXTENSIONS_LOCALE` 环境变量覆盖。
- 提供 `/config:language` 交互式命令，也支持 `/config:language en-US` 直接设置。
- 加载并校验 catalog，要求每个消息 key 同时提供两种语言。
- 为 UI、命令描述和 Agent prompt 提供用户文案插值。
- 提供统一的用户提示出口 `notifyWithSource`：把提示画成会话区里的**带底色消息块**（用户消息同款底色，见下条），并配上 `[tag]` 来源标签，解决 Pi 对 `info` 级提示只显示暗灰无前缀文本、用户既分不清来源也不容易注意到的问题。所有包用同一个弱化色标标签（`NOTICE_TAG_COLOR`）：来源靠 tag 文本，不靠颜色 —— 9 个色槽分给 16 个包必然撞车，撞车后颜色反而误导。
- 提示落在消息下方、不进 LLM 上下文：通过 Pi 的自定义条目（`appendEntry` + `registerEntryRenderer`）实现，条目只在本地渲染，不消耗上下文窗口。
- 提示块里的细节行（`details`）默认收起、只占一行，行尾带展开箭头（收起态 `▶`、展开态 `▼`，强调色）：全屏模式下直接点这条提示块切换，常规模式用 `Ctrl+O`（pi-tui 太老没有 `MouseRegion` 时自动退化成只能键盘展开）。用箭头而不是写「`Ctrl+O` 展开」：全屏与常规模式在条目渲染时区分不出来，箭头在两种模式下都成立，而且与清爽模式的折叠头用同一个字形。没有 `details` 的提示不带箭头，不会指一个点了没反应的入口。

## 安装

```bash
pi install npm:pi-extensions-i18n
```

各功能包会自动安装并加载这个公共依赖，因此安装任意使用它的功能包即可使用语言命令。只有不安装其他功能包、想单独使用语言命令时，才需要直接安装本包。

## 统一的提示出口

```ts
import { NOTICE_TAG_COLOR, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** 本扩展的提示标签；短且唯一。 */
const NOTICE_TAG = "distill";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("failed") });
```

输出是一个和用户消息同款的**实心底色块**，首行是 `[distill] 提示正文`：标签统一用共享的弱化色 `NOTICE_TAG_COLOR`，正文颜色由 `level` 决定（`warning` 黄、`error` 红、`info` 用扩展消息正文色），也可以用 `textColor` 覆盖成结论行自带的语义色（`dim`/`success` 等）。级别色是语义色，保持不变；只有来源标签不再用颜色当身份标识。

渲染细节：

- 只有 TUI 会把提示画成底色块；rpc/print/json 仍走 `ctx.ui.notify`，输出纯文本 `[distill] 提示正文`，不会出现 ANSI 乱码。
- 底色块由本包的扩展入口 `installNoticeRenderer(pi)` 注册一次，因此使用本包的功能包必须在自己的 `pi.extensions` 里加载 `../pi-extensions-i18n/index.ts`。
- 老版本 Pi 没有这两个能力时不会注入，提示自动退回 `ctx.ui.notify`（仍然可见，只是没有底色）。

需要更细粒度控制时用 `formatNotice({ source, message, mode, theme })` 只取文本。

安装后重新加载 Pi：

```text
/reload
```

## 语言优先级

```text
PI_EXTENSIONS_LOCALE 环境变量
    > 持久化配置
    > 默认 zh-CN
```

选择 `auto` 时会检查 `LC_ALL`、`LC_MESSAGES` 和 `LANG`：中文系统语言解析为 `zh-CN`，其他语言解析为 `en-US`。同时接受 `zh` 和 `en` 简写。

示例：

```bash
PI_EXTENSIONS_LOCALE=en-US pi
```

```text
/config:language en-US
```

## 扩展作者 API

本包导出功能扩展使用的语言和 catalog 原语：

```ts
import {
  createTranslator,
  getLocale,
  loadCatalog,
} from "pi-extensions-i18n";

const messages = loadCatalog(new URL("../locales/messages.json", import.meta.url));
const i18n = createTranslator(messages);

i18n.t("description");
getLocale();
```

catalog 条目必须同时包含两种语言：

```json
{
  "description": {
    "zh-CN": "扩展描述",
    "en-US": "Extension description"
  }
}
```

无效 catalog 会在加载阶段失败，让缺失翻译在测试和 CI 中暴露，而不是静默向用户泄露单一语言文案。

## 要求

- Node.js 22 或更高版本。
- 使用 `/config:language` 命令时需要 Pi 扩展运行时；`/pi-language` 仍作为兼容别名保留。

## 许可证

[MIT](../../LICENSE)
