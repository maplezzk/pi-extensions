---
name: configure-pi-extensions-i18n
description: "配置 Pi 扩展共享语言并排查 locale 优先级、持久化设置和 catalog。Use when changing zh-CN/en-US/auto language behavior."
---

# 配置 pi-extensions-i18n

## 修改语言

优先使用 `/config:language zh-CN|en-US|auto`；不带参数时使用交互界面。设置持久化到实际 Pi agent 目录的 `extensions/pi-extensions-i18n/config.json`。

语言优先级：

1. `PI_EXTENSIONS_LOCALE`；
2. 持久化配置；
3. 默认 `zh-CN`。

`auto` 根据 `LC_ALL`、`LC_MESSAGES`、`LANG` 选择中文或英文。`/pi-language` 只是兼容别名。

## 验证

执行语言命令后观察下一个使用共享 i18n 的扩展文案。若环境变量存在，它会覆盖持久化值；必须先报告这个覆盖关系，不能反复改 JSON。修改 catalog 时，每个 key 必须同时有 `zh-CN` 与 `en-US`，缺失翻译应作为加载错误修复，不能静默 fallback。
