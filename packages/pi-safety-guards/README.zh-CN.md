# pi-safety-guards

面向 Pi 的可配置 Bash 安全规则：选择预设、覆盖单条规则，或添加自己的匹配器。不要求使用特定构建工具、IDE、删除工具或个人工作区。

[English](./README.md)

## 安装

```bash
pi install npm:pi-safety-guards
```

本包需发布后才能通过 npm 安装。安装或修改配置后执行 `/reload`。

## 默认行为

没有配置时只启用 `destructive-operations` 预设，对目前能够识别的危险操作要求确认。**不强制使用 trash，不禁止 Maven，不要求 IDEA，不限制目录，也不自动信任技能目录。**

| 预设 | 规则 ID | 匹配范围 | 默认动作 |
| --- | --- | --- | --- |
| `destructive-operations` | `filesystem.delete` | 实际执行的 rm/rmdir | confirm |
| `destructive-operations` | `filesystem.format` | 实际执行的 mkfs/mkfs.* | confirm |
| `destructive-operations` | `filesystem.ownership` | 实际执行的 chown | confirm |
| `destructive-operations` | `shell.fork-bomb` | 已支持的冒号函数 fork bomb 形式 | confirm |
| `workspace-boundary`（需主动选择） | `paths.workspace` | Bash 显式引用的路径超出 `.` | block |

命令解析覆盖现有支持的 wrapper、字面量嵌套 shell、命令替换和重定向。`echo 'rm file'` 中的文案、`git rm` 中的子命令不视为实际执行 rm。

## 配置

文件：`<pi-agent-dir>/extensions/pi-safety-guards/config.json`，遵守 `PI_CODING_AGENT_DIR`。每次扩展加载时读取，修改后 `/reload`。

```json
{
  "presets": ["destructive-operations"],
  "rules": []
}
```

- 未写 `presets` 使用默认预设；显式空数组表示不选择预设。
- `rules` 按稳定 ID 覆盖所选预设中的规则或添加规则，列表内不能出现重复 ID。
- 已有规则可覆盖 `action`、`match`、`message`，或设置 `enabled: false`。
- 新启用规则必须提供 `id`、`action` 和 `match`。
- 未知字段、预设名、无效规则会明确报错，不会悄悄忽略。
- 预设和规则都为空时不注册检查 hook，并提示当前没有启用保护。

### 动作

- `warn`：不阻断，将提醒附加到对应工具结果，无 UI 模式也可见。
- `confirm`：合并命中的规则后询问一次；无法交互或用户未确认时阻断。
- `block`：不询问，直接拒绝操作。

多条规则命中时，优先级为 `block > confirm > warn`，反馈包含命中的规则 ID。没有依赖先后顺序、可绕过后续检查的 allow 规则。替代建议只是文案，插件不会自动执行替代命令。

```json
{
  "presets": ["destructive-operations"],
  "rules": [
    { "id": "filesystem.delete", "action": "block", "message": "请使用团队选择的删除工具。" },
    { "id": "filesystem.ownership", "enabled": false },
    { "id": "team-build", "action": "confirm", "match": { "commands": ["custom-build"] } }
  ]
}
```

`message` 可以是非空本地字符串，也可以是同时含 `zh-CN` 和 `en-US` 的对象。[团队策略示例](./examples/team-policy.json) 展示了如何用配置表达构建工具与删除习惯；它不是默认策略。

### 匹配器

每条规则只能选择一种匹配方式：

| `match` | 含义 |
| --- | --- |
| `{ "commands": ["tool", "wrapper"] }` | 实际执行程序的 basename 精确匹配，不做原始命令字符串包含判断 |
| `{ "detector": "disk-format" }` | 现有磁盘格式化命令检测器 |
| `{ "detector": "fork-bomb" }` | 现有冒号函数检测器 |
| `{ "detector": "in-place-edit" }` | sed 原地编辑选项，需主动选择 |
| `{ "detector": "home-root" }` | 未加引号的独立 `~` 参数，需主动选择 |
| `{ "detector": "root-search" }` | find 参数为 `/`，需主动选择 |
| `{ "outsideRoots": [".", "../shared"] }` | 显式路径超出配置的允许根 |
| `{ "module": "./rules/deploy.mjs" }` | 显式选择的可信本地匹配器模块 |

### 目录策略

目录预设需主动选择。相对根路径以当前 Pi 工作目录为基准，也支持绝对路径和 `~/`。只信任传入的根目录，不隐式加入 cwd、`/tmp`、`/var`、skills、PATH 中的程序目录或 shell 设备路径。预设通过 `.` 显式允许 cwd；需要时自行添加额外根或 `/dev/null` 等设备路径。

不读取其他扩展的私有会话条目。集成代码可使用导出的 `findOutOfScopeBashPaths(command, cwd, roots)`，在自定义匹配器中提供自己计算的目录列表。

### 本地规则模块

模块路径以配置文件所在目录为基准，不接受模型输入指定加载路径。使用默认导出匹配函数的本地 JavaScript ES 模块：

```js
export default ({ commands }) => commands.some(
  ({ name, args }) => name === "example-deploy" && args.includes("--production"),
);
```

函数接收冻结的 `{ command, cwd, commands: [{ name, args }] }` 摘要，返回布尔值或 `Promise<boolean>`，不会收到 Pi 执行接口。编写有类型的集成时，可从 `pi-safety-guards` 导入 `RuleContext` / `RuleMatcher` 类型。

只加载明确配置且启用的模块。加载失败、匹配抛错、返回非布尔值或异步工作超过 5 秒，均带规则 ID 报错并阻断。reload 会读取更新的模块文件。模块拥有进程权限，超时无法中断同步死循环或撤销副作用，因此只能加载可信代码，不是沙箱。

## 能力边界与错误

本包监听 Pi 的 `bash` 工具，不覆盖所有 shell、自定义工具、用户直接执行的 shell 或程序内部文件操作。不实现 PowerShell，不模拟所有工作目录变化，不解析任意变量计算出来的路径。目录检查针对可静态识别的引用和已知符号链接，不是操作系统访问控制。默认预设也不保证检测到所有危险命令，例如所有 dd/chmod 形式。

规则启用后，Bash 解析或规则执行失败会阻断。缺少配置文件采用默认预设；损坏配置会阻断 Bash，修复并 reload 后恢复。此前实验版本的 `maven`、`javaSkill`、`dangerCommands`、`bashDirectoryScope` 不再接受，应显式转换为规则。

## 验证

```bash
npm run check
```

测试使用解析 fixture、fake Pi 事件和临时规则模块。真实终端确认和模型运行需要单独验证。默认运行时文案通过 `pi-extensions-i18n` 提供中英文。
