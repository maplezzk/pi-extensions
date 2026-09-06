# pi-naming

自动或手动给 Pi session 和终端命名。

[English](./README.md)

## 安装与使用

```bash
pi install npm:pi-naming
```

本包发布后可通过 npm 安装。安装或修改配置后执行 `/reload`。

- **首条消息自动命名**：新建且未命名的 session 收到首条真实用户输入后，后台生成标题，同步允许修改的 session、workspace 和 tab。
- **`/rename [名称]`**：显式指定名称，或省略名称、根据当前分支用户消息生成标题。与自动命名使用相同的目标配置和执行逻辑。
- 手动生成时综合当前分支的全部用户输入，围绕主要任务命名；后续明确纠正或目标变更优先，“继续”“验证一下”“提交”等流程性跟进不应盖过主题。不会读取其他分支、assistant 回复或工具输出。自动命名仍仅在首条输入时尝试一次，不随每轮对话更新。
- 不覆盖已有名称的自动命名结果。手动命令优先于尚未完成的旧请求；会话切换或 reload 后丢弃旧结果和错误。
- 各目标独立执行。终端不支持、被禁用、缺少归属信息或改名失败均明确报告，不阻止 session 和其他可用目标改名。无交互 UI 时通过 Pi 消息报告。

## 配置

文件：`<pi-agent-dir>/extensions/pi-naming/config.json`，遵守 `PI_CODING_AGENT_DIR`。

```json
{
  "automaticNaming": true,
  "manualNaming": true,
  "targets": {
    "session": true,
    "workspace": true,
    "tab": true
  },
  "title": {
    "maxLength": 15,
    "preferredLength": 10,
    "language": "auto",
    "instructions": "",
    "timeoutMs": 10000
  }
}
```

`automaticNaming` 和 `manualNaming` 独立控制自动入口和 `/rename` 命令。`targets` 分别控制 session、workspace、tab；全部默认开启。仅需 session 命名时关闭两个终端目标，此时不加载终端模块。

| 标题字段 | 默认值 | 含义 |
| --- | --- | --- |
| `maxLength` | `15` | 生成标题最大 Unicode 码点数，超出时截断 |
| `preferredLength` | `10` | 提示模型优先采用的长度，不得超过最大长度 |
| `language` | `"auto"` | 跟随消息主要语言，或指定 `English`、`日本語` 等 |
| `instructions` | `""` | 追加的命名风格要求，不是模板或可执行代码 |
| `timeoutMs` | `10000` | 标题请求超时（毫秒） |

长度和超时必须是正安全整数，超时不超过 `2147483647` 毫秒。未知字段和非法配置会明确报错，不注册功能。缺少配置文件时使用默认值。显式输入的名称不受生成标题长度限制；补充提示不会绕过生成结果的单行清理和长度限制。

例如较长英文标题：`maxLength: 60`、`preferredLength: 40`、`language: "English"`。模型和鉴权直接复用 Pi 当前选择；UI 语言与标题语言独立。

## 独立使用与组合

- `pi-terminal-mux` 是自动安装的库依赖，无需额外启用扩展；负责目标探测与终端执行，不负责生成标题。
- 不依赖 `pi-interactive-subagents` 或 `pi-session-tools`。没有终端后端时仍可独立命名 session。
- 启动方可通过 terminal-mux 的 `PI_TERMINAL_RENAME_CONTEXT` 协议传递独占终端目标。子会话仍可命名 session，但不改共享 workspace；只改启动方明确授予的 pane/tab。
- tmux/WezTerm/Otty/Orca 分屏不代表独占 window/tab，归属无法确认时跳过并说明原因，不扩大操作范围。
- 使用 `pi-interactive-subagents` 时，需在它的 `subagentExtensions` 中显式加载本包入口；仅在主会话安装本包不会绕过子代理的扩展隔离设置。

普通会话仍遵守 mux 后端的显式开关：`PI_SUBAGENT_RENAME_TMUX_WINDOW=1`、`PI_SUBAGENT_RENAME_TMUX_SESSION=1`、`PI_SUBAGENT_RENAME_HERDR_WORKSPACE=1`。终端目标缺少 ID 时不会使用当前焦点或第一个 tab 代替。实际目标可能是 pane、tab、window、workspace 或 session，结果中会说明。

发布前，terminal-mux 依赖下限必须对齐实际提供目标归属 API 的已发布版本。

## 验证

`npm run check -w pi-naming` 覆盖独立使用、组合改名、部分失败、配置校验和并发请求失效。真实终端及模型调用需单独验证。
