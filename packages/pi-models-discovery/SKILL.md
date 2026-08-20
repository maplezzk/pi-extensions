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

只处理带 `discoverModels: true` 的 provider。确认 `baseUrl`、`api`、可选 `apiKey`、headers/compat 以及服务的 `GET {baseUrl}/models` 响应。

## 修改

优先使用 `/config:model-discovery` 添加、删除或重新发现 provider；命令会备份并格式化重写 `models.json`，注释与原排版不会保留。手工修改时，provider 至少提供 `baseUrl`、`api`、`discoverModels: true`；修改后需要 `/reload`。

`apiKey` 可用字面量、`$ENV_VAR` 或 `${ENV_VAR}`；`!command` 不用于发现请求，会被跳过并警告。不要把密钥写入 Skill、仓库或回复。

## 验证

- `/config:model-discovery-refresh` 强制联网刷新并更新缓存；旧命令名仅为兼容别名。
- 打开 `/model` 也会触发在线刷新。
- 逐个 provider 报告成功或失败。失败时可保留 `models.json` 中手写的 `models` 作为显式离线回退，但不能把缓存或静态模型冒充本次发现成功。
