---
name: configure-pi-models-discovery
description: "配置与排查 models.json 的动态模型发现、缓存刷新、鉴权和离线回退。Use when adding discoverModels providers or refreshing model catalogs."
---

# 配置 pi-models-discovery

## 诊断

读取实际 Pi agent 目录中的：

- `models.json`：provider 配置；
- `extensions/pi-models-discovery/cache.json`：启动缓存；
- `models.json.discovery-bak`：交互配置写回前的备份。

只处理带 `discoverModels: true` 的 provider。确认 `baseUrl`、`api`、可选 `modelsUrl` / `apiKey`、headers/compat 以及服务的模型列表响应。发现请求使用 `GET modelsUrl`（完整 URL，不追加 `/models`）；未配置或为空时使用 `GET {baseUrl}/models`。`modelsUrl` 仅影响发现和刷新，不改变聊天请求的 `baseUrl`；它会接收现有鉴权信息，须使用可信端点。

## 修改

优先使用 `/config:model-discovery` 添加、删除或重新发现 provider；命令会备份并格式化重写 `models.json`，注释与原排版不会保留。手工修改时，provider 至少提供 `baseUrl`、`api`、`discoverModels: true`；修改后需要 `/reload`。

`apiKey` 可用字面量、`$ENV_VAR` 或 `${ENV_VAR}`；`!command` 不用于发现请求，会被跳过并警告。不要把密钥写入 Skill、仓库或回复。

## 逐模型协议

`modelApis` 是模型 ID 到 Pi API 标识的精确映射，例如 `{"model-a":"openai-responses"}`。未匹配的条目沿用 provider 的 `api`，不自动探测协议能力，不创建模型或改写请求 model。首次发现、缓存启动和刷新都应用当前映射；目录缓存不保存覆盖值，因此映射变更无需重新联网发现。通过配置面板的「逐模型协议」行编辑即时生效；手编后用 `/reload`。发现失败时的手写 `models` 回退条目仍需自行填写相应 `api`。切换协议后开启新会话，不迁移 reasoning 或工具历史。

## 思考等级

发现的模型默认隐藏 `xhigh` / `max`（映射为 `null`），标准档位沿用 Pi 默认映射。provider 的 `compat.thinkingLevelMap` 可显式开启支持的档位或将不支持的档位置 `null`；非推理服务用 `compat.reasoning: false` 关闭推理，必要时配合 `compat.supportsReasoningEffort: false`。这两个扩展配置字段会提取到模型顶层，其余 compat 正常转发。逐模型差异用 `modelOverrides` 按 model.id 覆盖。旧缓存启动时会应用当前 compat 配置，无需联网刷新。

## 模型元数据

模型列表若返回名称、上下文窗口、输出上限、图片/推理能力或每百万 token 价格，发现时会自动读取，别名优先级见 README「模型元数据」表；provider 的 `compat.reasoning` 仍优先于服务声明。缺失或无效的字段沿用默认值，不要为服务已正确声明的元数据另加 `compat.reasoning` 或 `modelOverrides`。升级插件后缓存仍是旧默认值时，用 `/config:model-discovery-refresh` 重新拉取。

## 验证

- `/config:model-discovery-refresh` 强制联网刷新并更新缓存；旧命令名仅为兼容别名。
- 打开 `/model` 也会触发在线刷新。
- 逐个 provider 报告成功或失败。失败时可保留 `models.json` 中手写的 `models` 作为显式离线回退，但不能把缓存或静态模型冒充本次发现成功。
