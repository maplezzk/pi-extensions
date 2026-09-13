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

## 统一提示出口

功能包的用户可见提示必须走 `notifyWithSource`（而不是直接 `ctx.ui.notify`），否则 Pi 会把 `info` 级提示渲染成暗灰无前缀文本，用户分不清消息来自哪个扩展：

```ts
notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("failed") });
```

每个包用短的唯一 tag 与固定颜色；颜色只在 tui 模式添加（自动处理，不要自己在调用点拼 ANSI）。排查提示显示问题时，先确认调用是否走了这个出口，再看 tag 与 level 是否合理。
