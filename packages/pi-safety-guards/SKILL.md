---
name: configure-pi-safety-guards
description: "配置安全规则、可选预设、规则动作和本地匹配模块。Use when configuring safety presets, rule overrides or custom matchers."
---

# 配置安全规则 / Configure safety rules

本包不是维护者的技术栈规则集合。先理解用户希望保护什么，再选择预设和动作；不要默认禁止某个构建工具、要求某个 IDE 或替代删除程序。

This package is not the maintainer's technology policy. Ask what the user wants to protect, then select presets and actions. Do not assume a particular build tool, IDE or replacement deletion utility.

## 默认 / Defaults

无配置时启用 `destructive-operations`，对 rm/rmdir、mkfs/mkfs.*、chown 和支持的 fork bomb 形式要求确认。目录限制需显式选择 `workspace-boundary`。默认不限制 Maven、sed 或目录，也不隐式信任 skills、/tmp、/var。

Without configuration, `destructive-operations` asks for confirmation for the supported deletion, formatting, ownership and fork-bomb operations. Directory restrictions require opting into `workspace-boundary`. Build tools and directory roots are not constrained by default.

## 配置 / Configuration

读取 `<pi-agent-dir>/extensions/pi-safety-guards/config.json`，遵守 `PI_CODING_AGENT_DIR`。修改后 `/reload`。

- `presets`：选择预设，缺省采用默认预设；显式 `[]` 不选择预设。
- `rules`：按稳定 ID 覆盖或添加；已有规则可 `enabled: false`。
- `action`：warn / confirm / block，多条命中时 block > confirm > warn。
- `match`：commands / detector / outsideRoots / module，四选一。
- `message`：本地字符串或中英文对象，只有提示作用，不执行替代命令。

Read the config under the Pi agent directory and reload after changes. Rules override presets by ID or add new matchers. Actions are warn, confirm and block, in increasing priority. Suggestions are text, not executable commands.

未知字段、损坏配置和启用规则的异常必须报告并阻断受影响操作，不通过禁用保护隐藏错误。旧实验配置中的 maven/javaSkill 开关需转换为规则，不要恢复技术专属字段。

Report invalid configuration and enabled-rule errors; do not silently disable protection. Convert experimental technology-specific switches into explicit rules.

## 扩展 / Extensions

只有在内置命令/路径/检测器不够时才使用显式指定的可信本地 ES 模块。模块默认导出函数，接收不可变的命令摘要，返回布尔值。加载和异步匹配 5 秒超时；同进程代码并非沙箱，不能中止同步死循环。

Use a trusted local ES module only when built-in matchers are insufficient. Default-export a boolean matcher over the frozen command summary. Loading and asynchronous matching have a five-second deadline; same-process modules are not sandboxed.

## 验证 / Verification

- 用不同命令规则证明不绑定技术栈；同一检测器分别配置 warn/confirm/block。
- 无 UI 时 confirm 必须阻断，warn 必须在对应工具结果中可见。
- 目录策略只使用明确 roots，不依赖其他扩展的私有状态。
- 运行包级和仓库检查。未实际运行真实 Pi 确认时标 `NOT_RUN`。

Verify technology-neutral rules, action overrides, no-UI behavior and explicit directory roots. Run package and repository checks. Report real Pi confirmation as `NOT_RUN` unless actually exercised.
