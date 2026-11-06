# pi-safety-guards

Pi 的 Bash 安全规则插件：规则直接写在配置文件里，支持逐条设置动作、说明和扩展匹配器。

[English](./README.md)

## 安装

```bash
pi install npm:pi-safety-guards
```

安装或修改配置后执行 `/reload`。

## 默认规则

第一次运行时，如果配置文件还不存在，插件会把下面 4 条规则写进 `<pi-agent-dir>/extensions/pi-safety-guards/config.json`，之后只读这个文件。没有藏在代码里的内置规则，改文件就是改行为。

| 规则 ID | 匹配范围 | 动作 |
| --- | --- | --- |
| `filesystem.delete` | 实际执行的 rm/rmdir | confirm |
| `filesystem.format` | 实际执行的 mkfs/mkfs.* | confirm |
| `filesystem.ownership` | 实际执行的 chown | confirm |
| `shell.fork-bomb` | 支持的冒号函数 fork bomb 形式 | confirm |

这 4 条就是原来的 `destructive-operations` 预设，原文见 [config.example.json](./config.example.json)，可以整段复制。原来的 `workspace-boundary` 预设（目录越界即阻断）现在这样写：

```json
{ "id": "paths.workspace", "action": "block", "match": { "outsideRoots": ["."] } }
```

匹配基于解析后的命令，覆盖支持的 wrapper、字面量嵌套 shell、命令替换和重定向。`echo 'rm file'` 和 `git rm` 不视为实际执行 rm；`commandPattern` 是例外，它看原始命令文本。

## 配置

文件：`<pi-agent-dir>/extensions/pi-safety-guards/config.json`，agent 目录遵守 `PI_CODING_AGENT_DIR`。顶层只接受 `rules`。

```json
{
  "rules": [
    { "id": "filesystem.delete", "action": "confirm", "match": { "commands": ["rm", "rmdir"] } },
    {
      "id": "project.build",
      "action": "block",
      "match": { "commands": ["mvn"] },
      "message": { "zh-CN": "禁止直接运行 Maven。", "en-US": "Direct Maven execution is blocked." }
    },
    { "id": "paths.workspace", "enabled": false, "action": "block", "match": { "outsideRoots": ["."] } }
  ]
}
```

另见 [config.example.json](./config.example.json) 和 [custom-rules.json](./examples/custom-rules.json)。

- `rules`：规则数组，可以为空；为空表示没有任何保护，启动时会明确提示。
- 每条规则必须写 `id`、`action`、`match`；只写 `id` 不再有意义（预设已删除）。
- `enabled`：可选的布尔值；`false` 表示暂时停用这条规则但保留内容。停用的规则同样要写全 `id`、`action`、`match`。
- 列表内 ID 不能重复，字段名写错会直接报错，不会静默忽略。
- `message`：可选的非空文本，或包含 `zh-CN`、`en-US` 的对象。不填写时反馈规则 ID 和动作。

`/config:safety-guards`（等价于 `/config:safety-guards show`）只打印配置文件路径和当前生效规则，不打开菜单、也不改文件：

```text
配置文件：<pi-agent-dir>/extensions/pi-safety-guards/config.json
  filesystem.delete → confirm · commands: rm, rmdir
  project.build → block · commands: mvn
  paths.workspace → 已停用
```

停用的规则显示“已停用”。改完配置后执行 `/reload`。

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
| `{ "commandPrefixes": ["mkfs"] }` | 实际执行程序的 basename 以某个前缀开头 |
| `{ "commandPattern": ":\\(\\)\\s*\\{" }` | 对原始命令文本做正则匹配；不带 flags，引号内文本也算 |
| `{ "outsideRoots": [".", "../shared"] }` | 显式路径超出配置的允许根 |
| `{ "module": "./rules/deploy.mjs" }` | 可信的本地匹配器模块 |

`commandPattern` 是命令语法无法用命令名表达时的退路。它看的是原始命令文本，所以 `echo ':(){ :|:& };:'` 也会命中；需要精确到“命令加参数”的判断时用 `module`。

旧的 `detector` 匹配器已删除，因为它的逻辑藏在代码里而不在配置里。迁移对照：

| 已删除 | 替代写法 |
| --- | --- |
| `{ "detector": "disk-format" }` | `{ "commandPrefixes": ["mkfs"] }` |
| `{ "detector": "fork-bomb" }` | `{ "commandPattern": ":\\(\\)\\s*\\{" }` |
| `{ "detector": "in-place-edit" }` | 用 `module` 匹配器自己判断命令和参数 |
| `{ "detector": "home-root" }` | 用 `module` 匹配器自己判断命令和参数 |
| `{ "detector": "root-search" }` | 用 `module` 匹配器自己判断命令和参数 |

### 目录规则

相对根路径以 Pi 当前工作目录为基准，也支持绝对路径和 `~/`。只有列出的根才被允许，`["."]` 表示工作目录。安装 `pi-add-dir` 时会同时尊重其当前会话目录授权；`session_squash` 后会从被压缩的源分支恢复这份授权。需要时添加额外目录或 `/dev/null` 等设备路径。

自定义匹配器可使用导出的 `findOutOfScopeBashPaths(command, cwd, roots)`，提供自行计算的目录列表。

文件系统无法表示的名字（含 NUL，或单个分量超过 255 字节）不算路径引用，所以 `python3 -c '...'` 这类解释器程序正文不会让规则失败；整条路径长到无法表示的候选也只按普通路径判定范围，不会以异常阻断。

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

配置文件不存在时按没有规则处理；配置损坏、Bash 解析失败或启用规则异常时阻断 Bash，修复相应错误后恢复；修改配置需要 `/reload`。

运行时文案支持中英文。

## 开发

```bash
npm run check
```
