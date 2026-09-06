# pi-naming

在一个包内提供可独立配置的 Pi 会话命名和手动终端命名。

[English](./README.md)

## 安装

```bash
pi install npm:pi-naming
```

安装或修改配置后执行 `/reload`。本包需发布后才能通过 npm 安装。

## 功能

- **自动会话命名**：新建且未命名的 session 收到首条真实用户输入后，后台请求当前模型生成标题，默认优先 10 个字符以内，最多 15 个 Unicode 码点，可配置。只修改 Pi session 名称，不会自动改 workspace/tab，也不覆盖已有手动名称。
- **`/rename:workspace [名称]`**：手动修改终端工作区名称。省略名称时，根据当前 session 用户消息生成标题，再执行终端改名；仅成功且 `syncSessionName` 开启时同步 Pi session 名称。
- **`/rename:tab <名称>`**：手动修改终端标签名称，不修改 Pi session 名称，不请求模型。

标题请求默认 10 秒超时，可通过 `title.timeoutMs` 调整。会话切换或 reload 后丢弃旧结果；后续手动改名命令优先于尚未完成的旧命令。模型、鉴权和终端失败均明确报告，不伪报成功。

## 配置

文件：`<pi-agent-dir>/extensions/pi-naming/config.json`，遵守 `PI_CODING_AGENT_DIR`。

```json
{
  "automaticNaming": true,
  "workspaceRename": true,
  "tabRename": true,
  "syncSessionName": true,
  "title": {
    "maxLength": 15,
    "preferredLength": 10,
    "language": "auto",
    "instructions": "",
    "timeoutMs": 10000
  }
}
```

三个开关独立、默认均开启，关闭后不注册对应命令或 hook。只用自动会话命名时，把两个终端开关设为 `false`，此时不加载终端模块。缺少配置文件使用默认值；配置损坏会报告且不注册任何命名功能，修复后 `/reload`。

### 命名偏好

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `syncSessionName` | `true` | workspace 改名成功后同步 Pi session；关闭后只改终端 |
| `title.maxLength` | `15` | 生成标题的最大 Unicode 码点数，超出时截断 |
| `title.preferredLength` | `10` | 提示模型优先采用的长度，不得超过最大长度 |
| `title.language` | `"auto"` | 跟随用户消息主要语言；也可填写 `English`、`日本語` 等语言名称 |
| `title.instructions` | `""` | 追加到命名系统提示的风格要求，不是模板或可执行代码 |
| `title.timeoutMs` | `10000` | 生成标题的超时时间（毫秒） |

长度和超时必须是正安全整数，超时最多 `2147483647` 毫秒。未知字段、空语言或非法配置会明确报错，不注册命名功能。补充提示不改变最终的单行清理和长度限制。

例如较长英文标题可设置 `title.maxLength: 60`、`title.preferredLength: 40`、`title.language: "English"`。标题配置同时用于自动 session 命名和无参数 workspace 命名；显式输入的名称不受这些生成限制影响。模型继续使用 Pi 当前选择，不额外配置模型或鉴权。

## 依赖与边界

- 标题生成是包内模块，通过 `pi-ai` 使用当前 Pi 模型和鉴权。
- 终端操作交给 `pi-terminal-mux`，不支持、关闭或失败均不能当作成功。没有终端后端也可使用自动会话命名。
- 不依赖 `pi-session-tools`；会话压缩和输出缓存继续留在原包。

终端后端开关仍由 terminal-mux 管理：

- tmux window 改名：`PI_SUBAGENT_RENAME_TMUX_WINDOW=1`。
- tmux session 改名：`PI_SUBAGENT_RENAME_TMUX_SESSION=1`。
- Herdr workspace 改名：`PI_SUBAGENT_RENAME_HERDR_WORKSPACE=1`。

不同后端的实际目标可能是 pane、window、tab、workspace、session 或 terminal。发布本包前，terminal-mux 依赖下限必须对齐实际提供改名结果 API 的已发布版本。

## 国际化

运行时文案和提示词通过 `pi-extensions-i18n` 提供中英文。
