# pi-spec

面向 [Pi 编码助手](https://pi.dev) 的规格驱动开发工作流扩展。它把 requirements、design、tasks 和 verification 持久化为项目产物，按明确阶段推进，并根据当前阶段保护写入。

[English](./README.md)

## 功能

- 在 `.pi/specs/<slug>/` 保存规格，`state.json` 由插件管理；文档顶部的 frontmatter 是该状态的只读显示层。
- 支持 `strict`：计划和验证阶段逐阶段人工审批；也支持 `quick`：自动接受 requirements/design，但实现前仍保留 tasks 人工审批。
- 文档写完后必须调用 `spec_submit`；工具会校验文档并记录 SHA-256，不会替代人工审批。
- 提供无参数的状态动作菜单、`/spec` 的 Tab 补全，以及 `spec_request_approval` 工具，批准不再需要记忆参数或手敲子命令。
- 批准与文档哈希绑定；已批准文档被修改或删除时，插件会回退对应阶段并清除下游批准。
- 通过原生 `tool_call` 钩子保护 `state.json` 和不符合当前阶段的文件。
- 会话 reload 和树导航后恢复激活规格与工具集。
- TUI 显示 Workflow 风格的进度 Widget，RPC 模式显示纯文本状态。

## 安装

```bash
pi install npm:@maplezzk/pi-spec
```

然后在 Pi 中执行 `/reload`。

## 命令

不带参数的 `/spec` 会列出当前状态可用的动作，因此不需要记忆任何参数：

```text
/spec                    列出当前可用的动作
/spec new [slug]         创建规格；会提示输入名称和标题
/spec use [slug]         激活规格；不给名称时列出已有规格
/spec status             显示并刷新进度
/spec approve            确认当前已提交阶段
/spec revise [artifact]  回退阶段；不给阶段名时列出可回退的阶段
/spec continue           继续执行已批准的实现任务
/spec stop               退出 spec 模式并恢复原工具集
```

Tab 补全只列出当前状态下合法的动作，并能补全已有规格名和可回退阶段。`<artifact>` 可选 `requirements`、`design`、`tasks` 或 `verification`。旧的 `--title` 写法仍然生效，但已不再需要，也不再出现在帮助里。

多数情况下根本不需要打命令：文档待批时模型会调用 `spec_request_approval`，弹出与 `/spec approve` 完全相同的确认框。批准仍然必须你按键；该工具无法替你批准，headless 模式一律不批准。

## 工作流

```text
strict: requirements → approve → design → approve → tasks → approve → implementation → verification → approve → complete
quick:  requirements → design → tasks → approve → implementation → verification → approve → complete
```

用户必须在交互模式明确批准已提交文档。Headless 模式不会自动批准。批准一定需要在确认框里按键；`spec_request_approval` 只负责弹出该确认框，自己无法产生批准。实现阶段会跟踪 assistant 回复中的 `[DONE:TASK-id]` 标记；`tasks.md` 中全部任务完成后自动进入验证阶段。

## 写入策略

- 计划阶段：禁止 bash，只能编辑当前阶段文档。
- 实现阶段：允许修改源码，但整个 `.pi/specs/`（包括 `tasks.md`）冻结；修改定义须先 `/spec revise tasks`。
- 验证阶段：只有 spec 模式激活前就已启用 bash 时才保留 bash，并且只能编辑 `verification.md`。
- `state.json` 始终由插件管理，不能通过 `write` 或 `edit` 直接修改。

## 文档里的状态（frontmatter）

每份规格文档顶部有一段插件维护的 frontmatter，直接写着名称、阶段、状态、审批结果和任务进度，所以打开文档就能看到当前进展：

```markdown
---
# 本区块由 pi-spec 自动生成，仅供阅读；状态与批准以 state.json 为准
spec: checkout-flow
artifact: tasks
title: "结算流程"
profile: strict
phase: implementation
status: in_progress
approval: human
approved_at: 2026-09-10T09:12:44.031Z
tasks_done: 2/5
---
```

约定：

- `state.json` 仍是唯一真相。frontmatter 由插件从它派生并覆盖写入，读取时一律忽略：**写 `approval: human` 不构成批准**，也不会推进任何阶段。
- 文档指纹只覆盖 frontmatter 之后的正文。阶段、审批和进度同步不会让已有批准失效，勾选任务也不会回退阶段。
- 两份不一致时以 `state.json` 为准：旧规格没有这段头、或被手工改过，都会在激活规格时自动补写或回正，并提示改了哪几份文档。
- 兼容 v1：没有 frontmatter 的旧文档正文即全文，指纹与旧记录逐字节一致，所以旧规格的批准继续有效，激活时按当前协议补齐文档头。

## 配置

没有运行时设置或配置开关。`config.example.json` 有意保持为空；使用 `/spec` 命令和项目规格产物管理工作流。

## 开发

```bash
npm run typecheck
npm test
npm run check
```

包内提供 `configure-pi-spec` 技能用于操作排查。本扩展不启动 subagent 或 workflow，也不依赖 Plannotator。

## 国际化

用户可见的命令、工具、状态、提示和模板文案均通过 `pi-extensions-i18n` 提供 `zh-CN` 和 `en-US` 双语。

## 许可证

[MIT](../../LICENSE)

### 恢复与工具归属

会话和树导航只选择规格，不回滚共享的磁盘状态。恢复时校验状态形状、审批链和文档指纹。目标缺失或损坏时阻止工具执行，直到 `/spec use <slug>` 成功或 `/spec stop` 退出。兼容缺少 `completedTasks` 的旧 v1 记录与不带 frontmatter 的旧文档，但拒绝格式损坏的进度。

仅 drafting 暴露 `spec_submit`，仅待批状态暴露 `spec_request_approval`。恢复工具时保留其他扩展可观察到的增删，不恢复已注销工具。Pi 只提供最终启用集合，不提供每次变更的归属：如果其他扩展禁用了已经被 spec 隐藏的工具，插件无法观察到这个意图，停止 spec 时可能恢复该工具。重叠限制需要显式协调；这不是沙箱。

参数补全拿不到 session 上下文，只能使用最近一次会话或命令事件观察到的项目目录。因此补全反映的是当前会话所在目录，而不是任意目录。

## 阶段方法与迁移

包内 `procedures/*.json` 提供 requirements、design、tasks、implementation、verification 五阶段双语方法。每次模型请求前，`context` 事件仅保留一份当前正文和一条短状态，移除本扩展拥有的过期消息；相同内容复用，压缩后丢失则补回，不向会话历史反复追加正文。不激活时清理 spec 上下文，待批时仅提示等待或 revise，完成时只给完成提示、不新建文档。方法资源缺失、损坏或不可读时明确报错并阻断工具；修复包后用 `/spec use <slug>` 重试。

移除 `/skill:spec-mode`；只保留全局操作入口 `configure-pi-spec`，阶段方法自动加载。若曾单独复制旧 spec-mode 技能，请移除该副本以避免相互矛盾的指令。方法语言遵循共享 Pi 扩展语言设置。

进度仅来自持久化 `completedTasks` 和当前执行轮的新 DONE 标记，不扫描历史对话。revise requirements/design/tasks 清除受影响进度。DONE 不是测试成功证据；验证必须记录实际结果及未运行项。待批文档必须先 revise 才可编辑。工具限制不为 bash 或任意自定义工具提供沙箱。
