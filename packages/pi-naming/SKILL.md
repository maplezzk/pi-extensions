---
name: configure-pi-naming
description: 配置与排查 Pi 自动会话命名、终端 workspace/tab 改名和标题偏好。Use when configuring pi-naming.
---

# 配置 pi-naming / Configure pi-naming

读取 `<pi-agent-dir>/extensions/pi-naming/config.json`，遵守 `PI_CODING_AGENT_DIR`。修改后 `/reload`。完整字段与默认值见 [README](./README.md)、[中文说明](./README.zh-CN.md) 和 [配置示例](./config.example.json)。

Read `<pi-agent-dir>/extensions/pi-naming/config.json`, respecting `PI_CODING_AGENT_DIR`. Run `/reload` after changes. See the linked README and example for all fields and defaults.

- `automaticNaming`、`workspaceRename`、`tabRename` 独立开关，默认开启。Independent feature switches, enabled by default.
- `syncSessionName` 控制 workspace 成功改名后是否同步 session，默认开启。Controls session synchronization after a successful workspace rename; enabled by default.
- `title` 配置最大/偏好长度、语言、补充提示和超时；只影响生成名称，不修改显式名称。Configures generated title length, language, additional instructions and timeout; explicit names are unaffected.
- 模型和鉴权复用 Pi 当前选择。Uses Pi's current model and authentication.
- 自动 session 命名无需终端后端。Automatic session naming does not require a terminal backend.
- 配置错误必须报告；不要替用户忽略未知字段或更换模型。Report invalid configuration; do not silently ignore unknown fields or substitute models.
- unsupported/disabled/failed 不得当作成功，不同步 session。Never treat unsupported, disabled or failed terminal operations as success or sync the session.

## 验证 / Validation

运行 `npm run check -w pi-naming`。真实 Pi、终端及模型未验证时明确标记 `NOT_RUN`；单元测试不替代真实运行。

Run `npm run check -w pi-naming`. Mark real Pi, terminal and model verification as `NOT_RUN` when unavailable; unit tests are not a substitute.
