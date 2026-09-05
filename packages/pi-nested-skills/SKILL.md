---
name: configure-pi-nested-skills
description: "配置与排查 pi-nested-skills 的技能根目录、递归发现、别名调用和补全。Use when configuring nested skill roots, aliases, discovery, or completion."
---

# 配置 pi-nested-skills

## 诊断

读取实际 Pi agent 目录下的：

```text
extensions/pi-nested-skills/config.json
```

默认路径是 `~/.pi/agent/extensions/pi-nested-skills/config.json`；设置 `PI_CODING_AGENT_DIR` 时跟随 Pi 的 agent 目录。配置字段只有 `skillRoots`，可以是一个路径字符串或路径字符串数组。

技能根目录下的一级目录视为技能包；扩展会递归查找其中的 `SKILL.md`。如果根目录本身直接包含 `SKILL.md`，则把这个目录作为一个技能包处理。

## 修改

优先复制包内 [`config.example.json`](./config.example.json)，再修改 `skillRoots`。路径可以是绝对路径、`~/` 路径，或相对于 Pi agent 目录的路径。

也可以使用环境变量：

```text
PI_NESTED_SKILLS_ROOTS=~/shared-skills,skills
```

配置文件优先于环境变量；环境变量优先于默认的 Pi agent `skills` 目录。`PI_NESTED_SKILLS_DIR` 作为旧单目录名称保留兼容读取。

别名形式为 `/技能包:子目录.子目录`，例如 `/development:code-reviewer` 或 `/design:icons.favicon`。也支持 `/skill:技能包.子目录`；扩展会把它转换为 Pi 原生 `/skill:<name>`，由 Pi 负责技能正文展开。

## 验证

- 执行 `/skills` 查看递归发现的别名。
- 在输入框输入 `/`，确认补全同时保留 Pi 内置命令和嵌套技能。
- 手动调用一个嵌套别名并带参数，确认参数仍传给原生技能展开。
- 配置空目录、缺失目录或无 description 的 `SKILL.md` 时，确认 Pi/扩展明确报告诊断；不要把无法加载的技能静默显示为可用。
- 不要复制 Pi 原生 `read` 路径处理或技能正文展开逻辑。
