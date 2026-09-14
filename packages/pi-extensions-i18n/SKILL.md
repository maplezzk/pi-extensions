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

功能包的用户可见提示必须走 `notifyWithSource`（而不是直接 `ctx.ui.notify`），否则 Pi 会把 `info` 级提示渲染成暗灰无前缀的一行文字，用户既分不清来源也不容易注意到：

```ts
notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("failed") });
```

- 呈现：TUI 下画成会话区里的带底色消息块（落在消息下方，不进 LLM 上下文）；rpc/print/json 仍走 `ctx.ui.notify` 的纯文本。
- 标签：每个包用短的唯一 tag 与固定颜色；颜色只在 tui 模式添加（自动处理，不要自己在调用点拼 ANSI）。
- 依赖：底色块的渲染器由本包的扩展入口 `installNoticeRenderer(pi)` 注册一次，所以用它的包必须在 `pi.extensions` 里加载 `../pi-extensions-i18n/index.ts`，否则提示会退回纯文本（不报错、不丢提示）。
- 自带语义色的结论行（如「已打断，未判定」）用 `textColor` 传色，不要再自己写页脚状态行。

排查提示显示问题时，先确认包声明里加载了 i18n 入口，再看调用是否走了这个出口，最后看 tag 与 level 是否合理。
