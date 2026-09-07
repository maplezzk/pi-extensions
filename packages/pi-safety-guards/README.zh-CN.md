# pi-safety-guards

Pi 的 Bash 安全规则插件，支持选择预设、设置规则动作和扩展匹配器。

[English](./README.md)

## 安装

```bash
pi install npm:pi-safety-guards
```

安装或修改配置后执行 `/reload`。

## 预设

默认启用 `destructive-operations`，执行下列操作前要求确认：

| 预设 | 规则 ID | 匹配范围 | 动作 |
| --- | --- | --- | --- |
| `destructive-operations` | `filesystem.delete` | 实际执行的 rm/rmdir | confirm |
| `destructive-operations` | `filesystem.format` | 实际执行的 mkfs/mkfs.* | confirm |
| `destructive-operations` | `filesystem.ownership` | 实际执行的 chown | confirm |
| `destructive-operations` | `shell.fork-bomb` | 支持的冒号函数 fork bomb 形式 | confirm |
| `workspace-boundary`（可选） | `paths.workspace` | Bash 显式路径超出 `.` | block |

匹配基于解析后的命令，覆盖支持的 wrapper、字面量嵌套 shell、命令替换和重定向。`echo 'rm file'` 和 `git rm` 不视为实际执行 rm。

## 配置

文件：`<pi-agent-dir>/extensions/pi-safety-guards/config.json`。agent 目录遵守 `PI_CODING_AGENT_DIR`。

```json
{
  "presets": ["destructive-operations"],
  "rules": [
    { "id": "filesystem.delete", "action": "block" },
    { "id": "filesystem.ownership", "enabled": false },
    { "id": "example.command", "action": "confirm", "match": { "commands": ["example-command"] } }
  ]
}
```

将 `example-command` 替换为需要匹配的命令。另见 [config.example.json](./config.example.json) 和 [custom-rules.json](./examples/custom-rules.json)。

- `presets`：缺省使用默认预设，`[]` 表示不选择预设。
- `rules`：按 ID 覆盖所选预设中的规则，或添加新规则；列表内 ID 不能重复。
- 已有规则可覆盖 `action`、`match`、`message`，或设置 `enabled: false`。
- 新启用规则必须提供 `id`、`action` 和 `match`。
- `message`：可选的非空文本，或包含 `zh-CN`、`en-US` 的对象。不填写时反馈规则 ID 和动作。
- 预设和规则都为空时关闭检查，并提示当前没有启用保护。

使用 `/config:safety-guards` 打开常规 TUI 预设菜单，输入 `reset` 恢复默认预设；保存后执行 `/reload`。

### 动作

| 动作 | 行为 |
| --- | --- |
| `warn` | 放行，将提醒附加到对应工具结果，无 UI 模式也可见。 |
| `confirm` | 合并命中的规则后询问一次；无法交互或用户未确认时阻断。 |
| `block` | 不询问，直接拒绝。 |

多条规则命中时，优先级为 `block > confirm > warn`，反馈包含所有命中的规则 ID。

### 匹配器

每条规则选择一种匹配方式：

| `match` | 含义 |
| --- | --- |
| `{ "commands": ["example-command"] }` | 实际执行程序的 basename 精确匹配 |
| `{ "detector": "disk-format" }` | mkfs 或 mkfs.* |
| `{ "detector": "fork-bomb" }` | 支持的冒号函数 fork bomb 形式 |
| `{ "detector": "in-place-edit" }` | sed 原地编辑选项 |
| `{ "detector": "home-root" }` | 未加引号的独立 `~` 参数 |
| `{ "detector": "root-search" }` | find 参数为 `/` |
| `{ "outsideRoots": [".", "../shared"] }` | 显式路径超出配置的允许根 |
| `{ "module": "./rules/deploy.mjs" }` | 可信的本地匹配器模块 |

### 目录规则

相对根路径以 Pi 当前工作目录为基准，也支持绝对路径和 `~/`。只有列出的根才被允许，预设中的 `.` 表示工作目录。安装 `pi-add-dir` 时会同时尊重其当前会话目录授权；`session_squash` 后会从被压缩的源分支恢复这份授权。需要时添加额外目录或 `/dev/null` 等设备路径。

自定义匹配器可使用导出的 `findOutOfScopeBashPaths(command, cwd, roots)`，提供自行计算的目录列表。

### 自定义模块

模块路径以配置文件所在目录为基准。JavaScript ES 模块必须默认导出匹配函数：

```js
export default ({ commands }) => commands.some(
  ({ name, args }) => name === "example-deploy" && args.includes("--production"),
);
```

函数接收冻结的 `{ command, cwd, commands: [{ name, args }] }` 摘要，返回布尔值或 `Promise<boolean>`。包内导出了 `RuleContext` 和 `RuleMatcher` 类型。

只加载启用的模块。加载失败、匹配异常、非布尔返回或异步工作超过 5 秒，均会阻断操作。修改模块后执行 `/reload`。

模块拥有进程权限，超时无法中断同步死循环或撤销副作用，因此只能加载可信代码。

## 限制与错误

本包检查 Pi 的 `bash` 工具，不覆盖用户直接执行的 shell、其他工具或程序内部操作。不保证检测所有危险命令，不模拟所有工作目录变化，也不解析任意变量计算的路径。目录检查处理可静态识别的引用和符号链接，不是操作系统访问控制。

缺少配置文件时使用默认预设。配置损坏、Bash 解析失败或启用规则异常时阻断 Bash，修复相应错误后恢复；修改配置需要 `/reload`。

运行时文案支持中英文。

## 开发

```bash
npm run check
```
