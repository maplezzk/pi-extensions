# pi-models-discovery

通用模型发现插件：读取 `~/.pi/agent/models.json` 中带 `"discoverModels": true` 的 provider，请求 `GET {baseUrl}/models` 自动发现模型并注册，无需手写 `models` 数组。首次发现成功后模型列表持久化到本地缓存，之后每次启动直接读缓存，**不再请求网络**。

适合本地/自建 LLM 代理（一个网关暴露多个模型）、Ollama、vLLM 等 OpenAI 兼容服务。

## 安装

```bash
pi install npm:pi-models-discovery
```

## 配置

### 方式一：pi 终端内交互配置（推荐）

```
/model-discovery
```

交互式添加 / 删除 / 重新发现 provider：输入 id、baseUrl、api 类型、apiKey（可留空）、显示名（可留空），确认后写入 models.json 并**立即生效**（无需 /reload）。写入前自动备份到 `models.json.discovery-bak`。

注意：写回时 models.json 中的注释与自定义排版不被保留（会格式化为 4 空格缩进）。

### 方式二：手编 models.json

在 `~/.pi/agent/models.json` 的 provider 上加 `"discoverModels": true` 标记：

```json
{
  "providers": {
    "llm-proxy": {
      "name": "LLM Proxy",
      "baseUrl": "http://127.0.0.1:9000/pi/v1",
      "apiKey": "sk-1234",
      "api": "openai-completions",
      "discoverModels": true
    }
  }
}
```

`baseUrl` 和 `api` 必填；`apiKey` 可选（无鉴权服务可省略）。同一 `baseUrl+apiKey` 的多个 provider 共享一次 `/models` 请求。

手编方式修改配置后需 `/reload` 生效；`/model-discovery` 命令的修改立即生效。

## 刷新缓存

```
/model-discovery-refresh
```

强制重新拉取所有发现 provider 的模型列表并更新本地缓存，逐个 notify 结果。

## 行为

- **启动（缓存优先）**：缓存命中时直接用持久化的模型列表注册，零网络请求；缓存文件位于 `~/.pi/agent/extensions/pi-models-discovery/cache.json`。provider 配置指纹（baseUrl+api+apiKey+headers+compat）变化时缓存自动失效，重新走网络发现。
- **在线刷新**：`/model-discovery-refresh` 或 `/model` 打开时触发的 `refreshModels` 在线重新发现，并同步更新缓存。
- **离线 / 拉取失败**：保留 models.json 里手写的 `models`（如有，作为回退），并通过会话内 notify 显式警告，不静默降级；单个 provider 失败不影响其他 provider。
- **apiKey 解析**（仅发现请求）：支持字面量与 `$ENV_VAR` / `${ENV_VAR}` 插值；`!command` 形式跳过发现并显式警告（聊天请求仍由 pi 自身解析执行，不受影响）。
- 发现的模型默认参数：`reasoning: true`、`input: ["text", "image"]`、cost 全 0、`contextWindow` 1M、`maxTokens` 64K、`compat.supportsDeveloperRole: false`；provider 级 `compat` 会合并进每个发现的模型。
- 模型元数据可携带 `name` / `context_window`（或 `contextWindow`）/ `max_tokens`（或 `maxTokens`），缺失时用默认值。

## 卸载

```bash
pi remove pi-models-discovery
```

卸载后 provider 回退为 models.json 中的静态配置（手写 `models` 或空）。
