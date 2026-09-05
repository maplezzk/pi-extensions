---
name: configure-pi-safety-guards
description: Configure and verify pi-safety-guards dangerous-command, Bash path-scope, and Maven guards.
---

# 配置 pi-safety-guards

## 诊断

确认 `pi-safety-guards` 已安装且根扩展入口已启用。三组守卫分别监听 Pi 的 `tool_call` 事件：

- 危险命令：阻断 `rm`、`rmdir`、`sed -i`、直接搜索 `~`、`find /`；`chown`、`mkfs` 和 fork bomb 在 TUI 中先确认；
- Bash 路径范围：允许当前目录、`add_directory` 目录、skills 目录、`/tmp` 和 `/var`，同时检查嵌套 shell、wrapper、重定向及符号链接；
- Maven：默认阻断实际 Maven 调用，包括 wrapper 和字面量嵌套 shell。

两个已删除的 Java optional 守卫不属于本包，不要恢复或寻找它们的配置。

## Maven 提示配置

Maven 拦截提示的 skill 名读取自：

```text
<pi-agent-dir>/extensions/pi-safety-guards/config.json
```

字段包括 `dangerCommands`、`bashDirectoryScope`、`maven`（默认均为 `true`），以及 `javaSkill`。优先级为：配置文件 > `PI_JAVA_SKILL` > 默认 `java-build`。仅配置文件缺失时采用默认值。损坏配置会报错并阻断 Bash；修复配置后 `/reload`，不得静默跳过安全检查。

可参考 [`config.example.json`](./config.example.json)。`PI_CODING_AGENT_DIR` 按 Pi 标准约定决定 `<pi-agent-dir>`。

## 修改与开关

使用 Pi 的 package/resource 配置启用或禁用整个包。包内三个布尔开关可分别关闭守卫；关闭后不注册该功能的 hook，修改后需 `/reload`。

通知不属于本包。需要通知时单独安装 `pi-notifications`，不要把通知入口加回本包。

## 验证

先执行包级检查：

```bash
npm run check
```

重点确认：

- `rm -rf`、`sed -i` 和 Maven 调用被阻断；`git rm`、普通文本中的 `rm`、`command -v mvn` 不被误判；
- `/tmp`、`/var` 及其后代路径允许，`/tmp-other` 和 `/variable` 不允许；
- 配置文件中的 `javaSkill` 覆盖环境变量，环境变量在无配置文件时覆盖默认值；
- 非 TUI 模式不会为需要确认的危险命令放行；
- 包中不存在 `optional/enforce-java-rules.ts` 或 `optional/force-mvn-verify.ts`。

未执行真实 TUI 确认或 Maven 项目构建时，报告 `NOT_RUN`；不要把静态单元测试描述成真实工具执行。
