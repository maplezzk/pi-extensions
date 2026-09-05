# pi-spec-mode

面向 [Pi 编码助手](https://pi.dev) 的规格驱动开发工作流扩展。它把 requirements、design、tasks 和 verification 持久化为项目产物，按明确阶段推进，并根据当前阶段保护写入。

[English](./README.md)

## 功能

- 在 `.pi/specs/<slug>/` 保存规格，`state.json` 由插件管理。
- 支持 `strict`：计划和验证阶段逐阶段人工审批；也支持 `quick`：自动接受 requirements/design，但实现前仍保留 tasks 人工审批。
- 文档写完后必须调用 `spec_submit`；工具会校验文档并记录 SHA-256，不会替代人工审批。
- 批准与文档哈希绑定；已批准文档被修改或删除时，插件会回退对应阶段并清除下游批准。
- 通过原生 `tool_call` 钩子保护 `state.json` 和不符合当前阶段的文件。
- 会话 reload 和树导航后恢复激活规格与工具集。
- TUI 显示 Workflow 风格的进度 Widget，RPC 模式显示纯文本状态。

## 安装

```bash
pi install npm:pi-spec-mode
```

然后在 Pi 中执行 `/reload`。

## 命令

```text
/spec new <slug> [--title "标题"]   创建并激活规格
/spec use <slug>                     激活已有规格
/spec status                         显示并刷新进度
/spec approve                        确认当前已提交阶段
/spec revise <artifact>              回退阶段并清除下游批准
/spec continue                       继续执行已批准的实现任务
/spec stop                           退出 spec 模式并恢复原工具集
```

`<artifact>` 可选 `requirements`、`design`、`tasks` 或 `verification`。

## 工作流

```text
strict: requirements → approve → design → approve → tasks → approve → implementation → verification → approve → complete
quick:  requirements → design → tasks → approve → implementation → verification → approve → complete
```

用户必须在交互模式明确批准已提交文档。Headless 模式不会自动批准。实现阶段会跟踪 assistant 回复中的 `[DONE:TASK-id]` 标记；`tasks.md` 中全部任务完成后自动进入验证阶段。

## 写入策略

- 计划阶段：禁止 bash，只能编辑当前阶段文档。
- 实现阶段：允许修改源码，但 `.pi/specs/<slug>/` 仍受保护；只允许更新 `tasks.md`。
- 验证阶段：只有 spec 模式激活前就已启用 bash 时才保留 bash，并且只能编辑 `verification.md`。
- `state.json` 始终由插件管理，不能通过 `write` 或 `edit` 直接修改。

## 配置

没有运行时设置或配置开关。`config.example.json` 有意保持为空；使用 `/spec` 命令和项目规格产物管理工作流。

## 开发

```bash
npm run typecheck
npm test
npm run check
```

包内提供 `configure-pi-spec-mode` 技能用于操作排查。本扩展不启动 subagent 或 workflow，也不依赖 Plannotator。

## 国际化

用户可见的命令、工具、状态、提示和模板文案均通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US` 双语。

## 许可证

[MIT](../../LICENSE)
