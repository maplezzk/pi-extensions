# pi-extensions-i18n

Pi 扩展公共国际化运行时。它提供基于 catalog 的小型 API，支持 `zh-CN`、`en-US` 和自动语言选择。

## 为什么需要公共包

独立的 Pi 扩展仍然需要相同的基础能力：可移植的配置路径、语言优先级、fallback、catalog 校验和参数插值。把这些能力集中在这里，功能包就可以专注于自身逻辑，同时保持用户可见文案的一致性。

## 能力

- 支持 `zh-CN`、`en-US` 和 `auto` 语言偏好。
- 将设置持久化到 `~/.pi/agent/extensions/pi-extensions-i18n/config.json`。
- 支持 `PI_EXTENSIONS_LOCALE` 环境变量覆盖。
- 提供 `/pi-language` 交互式命令，也支持 `/pi-language en-US` 直接设置。
- 加载并校验 catalog，要求每个消息 key 同时提供两种语言。
- 为 UI、命令描述和 Agent prompt 提供用户文案插值。

## 安装

```bash
pi install npm:pi-extensions-i18n
```

`pi-distill`、`pi-tool-supervisor` 等功能包会把它作为公共依赖使用。如果只需要语言命令，也可以单独安装本包。

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
/pi-language en-US
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
- 使用 `/pi-language` 命令时需要 Pi 扩展运行时。

## 许可证

[MIT](../../LICENSE)
