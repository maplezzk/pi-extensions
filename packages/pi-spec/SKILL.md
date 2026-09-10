---
name: configure-pi-spec
description: "配置与排查 pi-spec 的规格阶段、strict/quick 审批、文档校验和写入守卫。Use when configuring or diagnosing the pi-spec workflow."
---

# pi-spec 操作入口 / Operations

没有配置开关；用 `/spec new [slug]` 创建，或 `/spec use [slug]` 激活项目规格（都不给名称时会提示或列出）。当前阶段方法由扩展自动加载，不再调用 `/skill:spec-mode`。

No configuration switches. Create with `/spec new [slug]` or activate with `/spec use [slug]`; both prompt or list when the name is omitted. The extension loads the current stage procedure automatically; `/skill:spec-mode` is no longer provided.

- `/spec`：不带参数列出当前可用的动作 / list the actions available now.
- `/spec status`：查看当前阶段 / inspect current stage.
- `/spec approve`：用户交互确认当前提交 / user confirmation of the current submission.
- `/spec revise [requirements|design|tasks|verification]`：修改前重新打开阶段；不给阶段名则列出可回退阶段 / reopen a stage before changes.
- `/spec continue`：继续已批准实现 / continue approved implementation.
- `/spec stop`：退出规格模式 / exit spec mode.

不用记参数：`/spec` 后按 Tab 只会列出当前状态合法的动作，并能补全已有规格名与可回退阶段。文档待批时模型可调用 `spec_request_approval` 直接弹出确认框，但批准仍然必须由用户按键，headless 一律不批准。

No arguments to memorize: Tab completion after `/spec` lists only the actions legal in the current state. When a document is pending, the model can call `spec_request_approval` to open the confirmation dialog, but approval still requires a user keypress and headless runs are never approved.

恢复失败或方法缺失时停止执行，报告错误；修复后用 `/spec use <slug>` 重试或 `/spec stop` 退出。不要修改 `state.json` 或编造批准。

每份文档顶部的 frontmatter 由扩展按 `state.json` 派生，只供阅读：不要手工编辑，也不要把里面的 `approval` 当作批准或状态依据。文档指纹只覆盖 frontmatter 之后的正文。

Stop and report recovery/procedure failures. After repair, retry with `/spec use <slug>` or exit with `/spec stop`. Never edit `state.json` or invent approval.

The frontmatter at the top of each artifact is derived from `state.json` for readability only: never edit it by hand and never treat its `approval` field as approval or state. Document fingerprints cover only the body after the frontmatter.

行为、限制与验证入口：中文见 [README.zh-CN.md](README.zh-CN.md)，English: [README.md](README.md)。
