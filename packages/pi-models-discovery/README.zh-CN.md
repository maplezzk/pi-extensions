# pi-models-discovery

通用模型发现插件：读取 `~/.pi/agent/models.json` 中带 `"discoverModels": true` 的 provider，请求 `GET {baseUrl}/models`（或配置的 `modelsUrl`）自动发现模型并注册，无需手写 `models` 数组。首次发现成功后模型列表持久化到本地缓存，之后每次启动直接读缓存，**不再请求网络**。

适合本地/自建 LLM 代理（一个网关暴露多个模型）、Ollama、vLLM 等 OpenAI 兼容服务。

## 安装

```bash
pi install npm:pi-models-discovery
```

## 配置

### 方式一：pi 终端内交互配置（推荐）

```
/config:model-discovery
```

命令打开配置面板，列出所有标记了 `discoverModels` 的 provider；选中某个 provider 打开它的字段页（发现开关、baseUrl、api 类型、apiKey、显示名），并可立即重新发现或删除它。添加 provider 时依次问 id、baseUrl、api 类型、apiKey（可留空）、显示名（可留空），写入 models.json 后**立即生效**（无需 /reload）。写入前自动备份到 `models.json.discovery-bak`。

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

`baseUrl` 和 `api` 必填；`apiKey` 可选（无鉴权服务可省略）。模型列表 URL、`apiKey`、`headers` 和 `compat` 相同的多个 provider 共享一次发现请求。

如果模型列表使用不同的端点，可在 models.json 中设置可选的 `modelsUrl`，值为模型列表的**完整 URL**（包含路径和所需查询参数）：

```json
{
  "providers": {
    "foo": {
      "baseUrl": "https://api.example.com/v1",
      "modelsUrl": "https://catalog.example.com/v1/models",
      "apiKey": "$FOO_API_KEY",
      "api": "openai-completions",
      "discoverModels": true
    }
  }
}
```

`modelsUrl` 仅用于模型发现和刷新，按原值请求；聊天请求仍使用 `baseUrl`。未配置或为空时，沿用 `{baseUrl}/models`。发现请求会将 provider 现有的 `apiKey` 和 `headers` 发送到该 URL，请使用可信端点。响应格式保持不变。

手编方式修改配置后需 `/reload` 生效；`/config:model-discovery` 命令的修改立即生效。

## 逐模型协议覆盖

自动发现不探测模型支持哪种协议；provider 的 `api` 仍是默认值。用 `modelApis` 为已验证的模型 ID 指定其他协议，无需新增 provider，也不改变发给上游的模型 ID：

这是通用的 Pi API 覆盖功能，适用于任意 provider 默认协议及 Pi 中已注册的协议，也包括扩展提供的自定义 API。下例模型名都是占位示例，不是内置分组或路由规则；每个模型应配置该 provider 实际提供的协议。

```json
{
  "providers": {
    "my-proxy": {
      "baseUrl": "https://proxy.example.com/v1",
      "apiKey": "$PROXY_API_KEY",
      "api": "openai-completions",
      "discoverModels": true,
      "modelApis": {
        "model-a": "openai-responses",
        "model-b": "anthropic-messages",
        "model-c": "google-generative-ai"
      }
    }
  }
}
```

键按模型 ID 精确匹配、区分大小写，不支持通配符，也不按模型品牌猜测能力。未匹配的模型沿用 provider 的 `api`；映射不存在的 ID 不会创建模型。例如 `/model` 中仍只有一个 `my-proxy/model-a`，请求的 `model` 仍为 `model-a`，协议为 Responses。`modelApis` 必须是非空模型 ID 到非空 API 字符串的对象；API 标识也可使用其他扩展注册的自定义协议。无效映射会明确警告并跳过发现注册，不静默改用另一协议。

首次发现、缓存启动、离线初始化、打开 `/model` 的在线刷新和显式刷新命令都应用同一映射。持久化缓存与共享发现请求缓存只保存没有协议覆盖的模型目录。修改或移除 `modelApis` 时复用目录、重新应用当前配置，旧协议不会残留在缓存模型中。`modelApis` 不改变目录指纹，也不妨碍多个 provider 共用一次目录请求。

在 `/config:model-discovery` 的「逐模型协议」行编辑 JSON 对象；留空或 `{}` 清除映射。面板修改即时保存并生效，目录已有缓存时无需联网；直接编辑文件后用 `/reload`。发现失败时仍沿用现有手写 `models` 回退规则，这些静态条目如有需要，应自行填写 `api`。扩展不迁移会话历史、不跨协议重试；改变模型协议后请开启新对话。

## 刷新缓存

```
/config:model-discovery-refresh
```

强制重新拉取所有发现 provider 的模型列表并更新本地缓存，逐个 notify 结果。

## 行为

- **启动（缓存优先）**：缓存命中时直接用持久化的模型列表注册，零网络请求；缓存文件位于 `~/.pi/agent/extensions/pi-models-discovery/cache.json`。provider 配置指纹（baseUrl+api+apiKey+headers+compat+modelsUrl）变化时缓存自动失效，重新走网络发现。
- **在线刷新**：`/config:model-discovery-refresh` 或 `/model` 打开时触发的 `refreshModels` 在线重新发现，并同步更新缓存。
- **离线 / 拉取失败**：保留 models.json 里手写的 `models`（如有，作为回退），并通过会话内 notify 显式警告，不静默降级；单个 provider 失败不影响其他 provider。
- **apiKey 解析**（仅发现请求）：支持字面量与 `$ENV_VAR` / `${ENV_VAR}` 插值；`!command` 形式跳过发现并显式警告（聊天请求仍由 pi 自身解析执行，不受影响）。
- 元数据缺失时，发现的模型默认参数为 `reasoning: true`、`input: ["text", "image"]`、cost 全 0、`contextWindow` 1M、`maxTokens` 64K、`compat.supportsDeveloperRole: false`。服务返回的元数据按下表替换这些默认值；provider 级 `compat` 会合并进每个发现的模型。
- 发现的模型默认将 `thinkingLevelMap.xhigh` / `max` 设为 `null`，不再假定所有后端支持这些额外档位。标准档位仍沿用 Pi 默认映射。若服务支持额外档位，可在 provider 的 `compat.thinkingLevelMap` 中显式开启，也可将任一不支持的档位置为 `null`。
- 非推理模型可设置 provider 的 `compat.reasoning: false`，让 `/thinking` 只提供 `off`。`reasoning` 和 `thinkingLevelMap` 会提取到模型顶层，其余 `compat` 字段（如 `supportsReasoningEffort`、`thinkingFormat`）正常转发。混合模型网关可用 `modelOverrides` 按 model.id 覆盖。旧缓存会在启动时应用当前推理配置，无需联网刷新。

下面是本地非推理服务的配置；若要开启已确认支持的额外档位，改用 `"thinkingLevelMap": { "xhigh": "xhigh", "max": "max" }` 并移除 `"reasoning": false`。

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "discoverModels": true,
      "compat": {
        "reasoning": false,
        "supportsReasoningEffort": false,
        "thinkingLevelMap": { "xhigh": null, "max": null }
      }
    }
  }
}
```

旧的 `/model-discovery`、`/model-discovery-refresh`、`/pi-model-discovery` 和 `/pi-model-discovery-refresh` 名称仍作为兼容别名保留。

## 模型元数据

发现流程按下表的优先级读取每个模型的元数据，使用第一个有效值：

| Pi 字段 | 模型列表字段，按优先级排列 |
| --- | --- |
| `name` | `name`、`display_name`，最后回退到模型 ID |
| `contextWindow` | `context_window`、`contextWindow`、`max_model_len`（vLLM）、`context_length`、`max_context_length`、`max_input_tokens`（Anthropic） |
| `maxTokens` | `max_tokens`、`maxTokens`、`max_output_tokens`、`max_completion_tokens` |
| `input` | 始终包含 `text`。显式包含 `text` 和/或 `image` 的 `input` 数组列出 `image` 时加入 `image`；否则看 `capabilities.vision` 或 `capabilities.image_input` 是否支持 |
| `reasoning` | provider 的 `compat.reasoning`、模型的 `reasoning`、`capabilities.reasoning`、`capabilities.thinking` |

能力字段可为布尔值或 `{ "supported": false }` 这样的对象。显式 `false` 会保留：不支持图片时使用 `input: ["text"]`，不支持推理时使用 `reasoning: false`。缓存启动和在线刷新均保留元数据。未声明的能力沿用既有默认值，插件不会推断额外思考档位。

token 上限必须为正的安全整数；无效值会回退到下一个别名或既有默认值。名称必须为非空字符串；`input` 中不支持的值会被忽略。

费用采用**每百万 token 的价格**，与 Pi 的 `cost` 字段一致：

| Pi cost 字段 | 模型列表字段，按优先级排列 |
| --- | --- |
| `input` | `cost.input`、`pricing.input_per_million` |
| `output` | `cost.output`、`pricing.output_per_million` |
| `cacheRead` | `cost.cacheRead`、`cost.cache_read`、`pricing.cache_read_input_per_million` |
| `cacheWrite` | `cost.cacheWrite`、`cost.cache_write`、`pricing.cache_creation_input_per_million` |

仅接受有限的非负数，零是有效价格。缺失或无效价格默认使用零。其他计价单位、长上下文阶梯价和模态专用价格不会映射到这四个字段；逐模型调整可使用 `modelOverrides`。

升级后运行 `/config:model-discovery-refresh`，用服务返回的元数据替换旧缓存中的默认值。

## 卸载

```bash
pi remove pi-models-discovery
```

卸载后 provider 回退为 models.json 中的静态配置（手写 `models` 或空）。
