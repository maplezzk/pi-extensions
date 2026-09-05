# pi-safety-guards

面向 [Pi coding agent](https://pi.dev) 的确定性安全守卫包，包含三组相互独立的守卫：危险 Bash 命令、Bash 路径范围和直接 Maven 调用。

[English](./README.md)

## 安装

```bash
pi install npm:pi-safety-guards
```

随后重新加载 Pi：

```text
/reload
```

包根入口会加载危险命令、Bash 目录范围和 Maven 三组守卫。通知适配器不在本包中；需要桌面通知时请另行安装 `pi-notifications`。

## 默认行为

- 阻断实际执行的 `rm` 和 `rmdir`，建议改用可恢复的 `trash` 命令；`git rm`、`npm rm` 等子命令不会误匹配。
- 阻断 `sed -i`，建议改用 Pi 的 `edit` 工具。
- 阻断直接搜索 `~` 和 `find /`，因为它们对日常 Agent 操作来说范围过大。
- 本地路径允许位于当前目录、`add_directory` 记录的目录、标准 skills 目录、`/tmp` 和 `/var` 内。检查前会解析嵌套 shell、wrapper、重定向和符号链接。直接执行单个 skills 目录下的脚本时，可以传入显式项目路径；命令链中的路径仍会正常检查。
- `chown`、`mkfs` 和 fork bomb 在 TUI 模式下需要用户确认；非交互模式直接阻断。
- 阻断直接 Maven 调用，包括 wrapper 和字面量嵌套 shell 调用，并提示使用配置的 Java 构建 skill。
- Bash 无法完整解析时直接阻断，不猜测其实际含义。

## 配置

守卫开关和 Maven 提示使用的 skill 从下面的文件读取：

```text
<pi-agent-dir>/extensions/pi-safety-guards/config.json
```

可以从 [`config.example.json`](./config.example.json) 开始：

```json
{
  "dangerCommands": true,
  "bashDirectoryScope": true,
  "maven": true,
  "javaSkill": "java-build"
}
```

配置文件优先级高于 `PI_JAVA_SKILL`，环境变量优先级高于内置默认值 `java-build`。缺少配置文件时使用默认值。配置损坏会明确报错并阻断 Bash，修复后 `/reload` 恢复。任一守卫开关设为 `false` 时不注册对应 hook；修改配置后需 `/reload`。`PI_CODING_AGENT_DIR` 按 Pi 的标准约定控制 agent 目录。

## 包边界

危险命令和 Bash 路径守卫都是确定性检查，不替代 Pi 自身的权限或沙箱。本包不包含 Java 源码规则提醒、强制 Maven 验证或通知逻辑。

## 要求

- Node.js 22 或更高版本。
- Pi 0.80.x 兼容扩展 API。

## 许可证

[MIT](../../LICENSE)
