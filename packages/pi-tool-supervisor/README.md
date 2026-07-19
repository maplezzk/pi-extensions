# pi-tool-supervisor

Pi 工具监督扩展。当前在 `edit` / `write` 执行完成后读取实际文件变化，并将 diff 发送给配置的侧边评审模型；后续可在同一包中增加其他工具监督能力。

## 安装

该包通过 Pi 原生 `tool_call` / `tool_result` 事件接入 `edit` / `write`，不依赖 `pi-tool-display`，也不会注册同名工具。未安装、未启用或未接管对应工具时，会显示 UI-only 审查状态；可用时则通过通用 result render middleware 把审查卡片追加到对应工具结果。`pi-tool-display` 不读取或解释 supervisor 字段。

通过 npm 安装：

```bash
pi install npm:pi-tool-supervisor
```

安装后用 `/reload` 重新加载扩展。

## 配置

交互式配置命令：

```text
/pi-tool-supervisor
```

配置文件保存在 Pi 全局扩展目录下，文件名为 `config.json`（设置 `PI_CODING_AGENT_DIR` 时使用该环境变量下的对应路径）。可通过 `/pi-tool-supervisor` 交互命令查看或修改。

命令会打开交互式配置菜单，支持配置总开关、超时（秒）、最终返回字符上限、规则行数、Reviewer 增删改、模型和规则文件。默认最长等待 `10` 秒、最终返回上限 `10000` 字符。规则文件仍可以通过 front matter 声明
`enabled`、`filePatterns`、`complexity` 和 `consumers`。

配置文件会在每次 `edit` / `write` 前重新读取，保存后立即生效。无论审查是否启用，最终返回内容超过 `maxOutputChars` 时都会写入 `/tmp/pi-tool-supervisor/` 临时文件。旧配置中的 `timeoutMs` 和 `maxChars` 仍兼容，会自动转换为新字段。

从 `pi-file-edit-review` 升级时，如果新目录尚无配置，扩展会继续读取旧的 `extensions/pi-file-edit-review/config.json`；通过 `/pi-tool-supervisor` 保存后，配置会写入新的 `extensions/pi-tool-supervisor/config.json`。
