# pi-extensions-i18n

Shared i18n runtime for pi extensions, with bilingual (zh-CN / en-US) support.

pi 扩展的公共中英文运行时。提供：

- `zh-CN`、`en-US` 和 `auto` 三种语言偏好；
- 统一读取 `~/.pi/agent/extensions/pi-extensions-i18n/config.json`；
- `/pi-language` 终端交互式语言配置命令；
- `PI_EXTENSIONS_LOCALE` 环境变量覆盖配置；
- 面向 UI、命令描述和 agent prompt 的翻译器，以及外部 JSON catalog 加载和校验。

## Install / 安装

```bash
pi install npm:pi-extensions-i18n
```

本包是共享 peer dependency，依赖它的扩展（如 `pi-distill`、`pi-tool-supervisor`）会自动引用，不会把配置复制到每个插件目录。

## Locale priority / 语言优先级

```text
PI_EXTENSIONS_LOCALE 环境变量 > 持久化配置 > 默认 zh-CN
```

`PI_EXTENSIONS_LOCALE` 和配置文件支持 `zh-CN`、`en-US`、`auto`，也接受 `zh`、`en` 简写。`auto` 根据 `LC_ALL`、`LC_MESSAGES` 或 `LANG` 判断系统语言。

```bash
PI_EXTENSIONS_LOCALE=en-US pi
```

在 pi 中执行 `/pi-language` 可通过 select 菜单保存语言；也可以直接执行 `/pi-language en-US`。

## Catalog layout / 翻译资源约定

扩展自己的翻译资源保留在对应包的 `locales/` 目录中，按源码模块拆分为 JSON 文件，例如 `pi-distill/locales/summary-utils.json`；本包自身的 `/pi-language` 文案位于 `locales/command.json`。

每个 catalog 条目必须同时包含 `zh-CN` 与 `en-US` 两个语言键（CI 强制检查）。运行时只共享语言解析、配置存储、catalog 校验和插值规则，避免各插件重复实现配置路径和 fallback。

## License

[MIT](../../LICENSE)
