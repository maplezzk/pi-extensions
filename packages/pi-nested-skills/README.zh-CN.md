# pi-nested-skills

Pi 的嵌套技能扩展：递归发现多级 `SKILL.md`，并为嵌套技能提供快捷别名、列表和补全。

[English](./README.md)

## 功能

- 递归扫描一个或多个可配置技能根目录下的 `SKILL.md`。
- 支持 `/development:code-reviewer`、`/design:icons.favicon` 等技能包别名。
- 保留 Pi 原生技能加载器负责 frontmatter 校验和正文展开；不重复实现 `read` 兼容层或技能展开。
- 将嵌套技能补全合并到 Pi 原生斜杠命令补全中，不影响内置命令。
- 提供 `/skills` 列出发现到的全部别名。
- 通过 Pi 的 `resources_discover` 事件注册发现到的技能文件。
- 所有用户可见文案都通过 `pi-extensions-i18n` 提供中英文版本。

## 安装

```bash
pi install npm:pi-nested-skills
```

然后在 Pi 中执行 `/reload`。

## 配置技能根目录

复制 [`config.example.json`](./config.example.json)，写入：

```text
<Pi agent 目录>/extensions/pi-nested-skills/config.json
```

`<Pi agent 目录>` 是 Pi 配置的 agent 目录，通常为 `~/.pi/agent`。扩展遵循 Pi 的 `PI_CODING_AGENT_DIR` 设置。

```json
{
  "skillRoots": [
    "~/shared-skills",
    "skills"
  ]
}
```

相对路径以 Pi agent 目录为基准。根目录的每个直接子目录视为一个技能包，扩展会递归发现其中所有可见目录下的 `SKILL.md`。如果根目录本身包含 `SKILL.md`，也会把它作为一个技能包处理。

环境变量兜底：

```text
PI_NESTED_SKILLS_ROOTS=~/shared-skills,skills
```

配置文件优先于环境变量，环境变量优先于默认的 `<Pi agent 目录>/skills`。`PI_NESTED_SKILLS_DIR` 作为单根目录的兼容别名保留。

## 别名与原生展开

对于 `development/code-reviewer/SKILL.md`，扩展提供：

```text
/development:code-reviewer [参数]
/skill:development.code-reviewer [参数]
```

输入事件会把别名转换为 Pi 原生的 `/skill:<frontmatter-name>` 形式，再由 Pi 读取技能正文，并按原生机制解析相对引用。如果多个技能共用同一个 frontmatter name，扩展不会猜测无路径的名称；请使用明确的技能包/路径别名。

使用 `/skills` 查看完整列表。输入 `/` 可在同一个列表中搜索 Pi 内置命令和嵌套技能。

## 可移植性与隐私

本包不读取凭据、不发起网络请求、不启动进程，也不假设固定的用户目录。它遵循 Pi 的 agent 目录配置，并支持显式指定项目或团队技能目录。

## 要求

- Node.js 22 或更高版本。
- Pi `>=0.80.0 <0.81.0`。

## 许可证

MIT — 详见仓库许可证。
