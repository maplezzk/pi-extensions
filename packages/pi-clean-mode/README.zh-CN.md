# pi-clean-mode

`pi-clean-mode` 把一轮 agent 运行的完整工作过程折叠成一行耗时头，对话里只留最终答案。按快捷键（默认 `f2`）可以随时展开回看。

## 改变了什么

一次提问通常会让 agent 执行很多次工具调用、穿插好几段解说，最后才给出答案。Pi 默认把这些全部展示出来。本扩展把除最终答案之外的内容都视为**工作过程**并折叠：

```
[用户消息]

用时 4m 26s ›
原因查到了：今天补货用了两天前的旧销量，低估了需求，所以看起来只够约 10 天。
```

展开后就是 Pi 原本的完整输出。

## 工作过程与最终答案怎么区分

Pi 在扩展入口导出了对话组件，本扩展替换 `AssistantMessageComponent.render` 与 `ToolExecutionComponent.render` 两个原型方法：

| 组件 | 折叠时的行为 |
|---|---|
| **带** tool call 的 assistant 消息 | 整条隐藏（解说属于工作过程） |
| **不带** tool call 的 assistant 消息 | 保留，并把耗时头插在它上方 |
| 工具行 | 整行隐藏 |

「不带 tool call 的消息就是最终答案」的依据是：agent 循环只有在一次回复不含 tool call 时才结束，所以一次运行里这样的消息只有最后那一条。

被隐藏的行渲染为 0 行，所以耗时头正好落在最终答案上方。

## 运行时的行为

agent 执行期间保持展开 —— 否则折叠状态下用户在答案出现前会什么都看不到。运行结束（`agent_settled`）后自动收起。如果用户在本次运行中手动切换过状态，本次运行不再自动收起。

## 命令与快捷键

| 触发方式 | 效果 |
|---|---|
| `f2` | 收起或展开本轮工作过程 |
| `/clean` | 同快捷键 |
| `/config:clean-mode` | 打印当前配置 |
| `/config:clean-mode <key>=on\|off` | 修改一个布尔配置并保存 |

## 配置

配置文件路径：`<pi agent 目录>/extensions/pi-clean-mode/config.json`，示例见 `config.example.json`。

```json
{
  "enabled": true,
  "autoExpandWhileRunning": true,
  "showRunHeader": true,
  "showExpandHint": true
}
```

| 配置项 | 含义 |
|---|---|
| `enabled` | 总开关。关闭后所有补丁直接放行原始渲染。 |
| `autoExpandWhileRunning` | 执行中自动展开，运行结束后自动收起。 |
| `showRunHeader` | 在最终答案上方显示 `用时 …` 折叠头。 |
| `showExpandHint` | 在折叠头末尾附带展开提示。 |

## 兼容性

本扩展替换 Pi 组件的原型方法，因此与 Pi 的组件导出面绑定（`AssistantMessageComponent.hasToolCalls`、`ToolExecutionComponent.render`，以及「空渲染等于 0 行」的行为）。它在 reload 与 shutdown 时还原原型，并且不会覆盖安装之后被其它扩展替换掉的原型。

选 `f2` 是因为 Pi 内置键位没有占用它。如果你改过 Pi 键位，请避免与它冲突。

## 安装

```bash
pi install npm:pi-clean-mode
```

## 开发

```bash
npm test
npm run typecheck
```

## License

[MIT](../../LICENSE)
