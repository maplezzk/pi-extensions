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
- 提供统一的用户提示出口 `notifyWithSource`：给提示加「来源标签 + 固定颜色」，解决 Pi 对 `info` 级提示只显示暗灰无前缀文本、用户分不清消息来自哪个扩展的问题。

## 安装

```bash
pi install npm:pi-extensions-i18n
```

各功能包会自动安装并加载这个公共依赖，因此安装任意使用它的功能包即可使用语言命令。只有不安装其他功能包、想单独使用语言命令时，才需要直接安装本包。

## 统一的提示出口

```ts
import { notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** 本扩展的提示标签；短且唯一。 */
const NOTICE_TAG = "distill";
/** 提示标签颜色；与其它扩展错开。 */
const NOTICE_COLOR: NoticeColor = "muted";
/** 本扩展的提示来源。 */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("failed") });
```

输出形如 `[distill] 提示正文`：标签按扩展固定色，正文保持原样，`level` 仍然决定 Pi 侧的黄色 `Warning:` / 红色 `Error:` 前缀。颜色只在 tui 模式添加，rpc/print/json 模式输出纯文本，不会出现 ANSI 乱码。

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
