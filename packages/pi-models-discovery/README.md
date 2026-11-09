# pi-models-discovery

Generic model discovery extension: reads providers marked with `"discoverModels": true` in `~/.pi/agent/models.json`, requests `GET {baseUrl}/models` (or a configured `modelsUrl`), and registers the discovered models automatically — no handwritten `models` array required. After the first successful discovery the model list is persisted to a local cache, so subsequent startups read the cache and **perform no network requests**.

Suitable for local/self-hosted LLM proxies (one gateway exposing many models), Ollama, vLLM, and other OpenAI-compatible services.

## Install

```bash
pi install npm:pi-models-discovery
```

## Configuration

### Option 1: interactive configuration inside pi (recommended)

```
/config:model-discovery
```

Interactively add / remove / rediscover providers. The command opens a settings panel that lists every provider marked with `discoverModels`; selecting one opens its fields (enable/disable discovery, baseUrl, api type, apiKey, display name) plus actions to rediscover or remove it. Adding a provider asks for id, baseUrl, api type, apiKey (optional) and display name (optional). Changes are written to models.json and take effect **immediately** (no /reload required). A backup is written to `models.json.discovery-bak` before each write.

Note: comments and custom formatting in models.json are not preserved on write (the file is reformatted with 4-space indentation).

### Option 2: edit models.json by hand

Add `"discoverModels": true` to a provider in `~/.pi/agent/models.json`:

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

`baseUrl` and `api` are required; `apiKey` is optional (omit for unauthenticated services). Multiple providers sharing the same model-list URL, `apiKey`, `headers`, and `compat` reuse a single discovery request.

If the model catalog uses a different endpoint, set the optional `modelsUrl` in models.json to its **complete URL** (including the path and any query parameters):

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

`modelsUrl` is used as-is for discovery and refresh only; chat requests still use `baseUrl`. When omitted or empty, discovery uses `{baseUrl}/models`. Discovery sends the provider's existing `apiKey` and `headers` to this URL, so use a trusted endpoint. The response format remains unchanged.

Hand edits require `/reload` to take effect; changes made through `/config:model-discovery` apply immediately.

## Per-model API overrides

Discovery does not probe which wire protocols a model supports. The provider's `api` remains the default. Set `modelApis` to select another API for specific, verified model IDs without adding another provider or changing the model ID sent upstream:

This is a general Pi API override: it works with any provider default and any API registered in Pi, including extension-defined APIs. The model names below are placeholders, not built-in groups or routing rules. Configure only protocols actually served by that provider for each model.

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

Keys match exact model IDs, including case; there are no wildcards or brand-based rules. Unmatched models use the provider's `api`. Mapping a missing ID does not create a model. For example, `/model` still has one `my-proxy/model-a` entry and sends `model: "model-a"`, using Responses. `modelApis` must be an object with nonempty model IDs and nonempty API strings; API identifiers may include custom APIs registered by other extensions. Invalid mappings skip discovery registration with a warning rather than silently selecting another protocol.

First discovery, cached startup, offline initialization, `/model` online refresh, and the explicit refresh command all apply the same mapping. The persistent cache and shared discovery-request cache store the catalog without these overrides. Changing or removing `modelApis` reuses the catalog and applies the current configuration, so old protocol choices do not survive in cached models. `modelApis` does not invalidate the catalog fingerprint or prevent providers from sharing one catalog request.

Edit **Per-model APIs** in `/config:model-discovery` as a JSON object; empty input or `{}` clears it. Panel changes are saved and applied immediately, without a network request when a catalog is already cached. Hand edits require `/reload`. Handwritten `models` remain the existing fallback when discovery fails; give those static entries their own `api` if needed. The extension does not convert session history or retry through another protocol; start a new conversation after changing a model's API.

## Refreshing the cache

```
/config:model-discovery-refresh
```

Forces a rediscovery of every discovery provider and updates the local cache, notifying the result for each provider.

## Behavior

- **Startup (cache-first)**: when the cache hits, models are registered directly from the persisted list with zero network requests. The cache lives at `~/.pi/agent/extensions/pi-models-discovery/cache.json`. The cache is invalidated automatically when the provider configuration fingerprint (baseUrl+api+apiKey+headers+compat+modelsUrl) changes, triggering a fresh network discovery.
- **Online refresh**: `/config:model-discovery-refresh`, or the `refreshModels` hook triggered when opening `/model`, rediscovers online and updates the cache.
- **Offline / fetch failure**: handwritten `models` in models.json (if any) are kept as a fallback, and an explicit warning is surfaced via in-session notify — never a silent degradation. One provider failing does not affect the others.
- **apiKey resolution** (discovery request only): supports literals and `$ENV_VAR` / `${ENV_VAR}` interpolation; `!command` values skip discovery with an explicit warning (chat requests are still resolved by pi itself and are unaffected).
- When metadata is absent, discovered models default to `reasoning: true`, `input: ["text", "image"]`, zero cost, `contextWindow` 1M, `maxTokens` 64K, and `compat.supportsDeveloperRole: false`. Advertised metadata replaces these defaults as described below. Provider-level `compat` is merged into every discovered model.
- Discovered models default `thinkingLevelMap.xhigh` / `max` to `null`; extra tiers are no longer assumed to work on every backend. Standard tiers keep Pi's default mapping. Opt in with provider-level `compat.thinkingLevelMap` when the service supports extra tiers, or set any unsupported tier to `null`.
- For non-reasoning models, set provider-level `compat.reasoning: false` so `/thinking` offers only `off`. `reasoning` and `thinkingLevelMap` are extracted to the model's top level; other `compat` fields (such as `supportsReasoningEffort` and `thinkingFormat`) are forwarded normally. Mixed-model gateways can use `modelOverrides` by model.id. Existing caches apply the current thinking configuration at startup without a network refresh.

Example for a local non-reasoning service. To enable verified extra tiers instead, use `"thinkingLevelMap": { "xhigh": "xhigh", "max": "max" }` and remove `"reasoning": false`.

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

The old `/model-discovery`, `/model-discovery-refresh`, `/pi-model-discovery`, and `/pi-model-discovery-refresh` names remain available as compatibility aliases.

## Model metadata

Discovery reads each model's metadata using the following precedence (first valid value wins):

| Pi field | Model-list fields, in precedence order |
| --- | --- |
| `name` | `name`, `display_name`, then the model ID |
| `contextWindow` | `context_window`, `contextWindow`, `max_model_len` (vLLM), `context_length`, `max_context_length`, `max_input_tokens` (Anthropic) |
| `maxTokens` | `max_tokens`, `maxTokens`, `max_output_tokens`, `max_completion_tokens` |
| `input` | Always includes `text`. `image` is added when an explicit `input` array containing `text` and/or `image` lists it; otherwise when `capabilities.vision` or `capabilities.image_input` is supported |
| `reasoning` | Provider `compat.reasoning`, model `reasoning`, `capabilities.reasoning`, `capabilities.thinking` |

Capability values may be booleans or objects such as `{ "supported": false }`. Explicit `false` is preserved: no image support produces `input: ["text"]`, and no reasoning support produces `reasoning: false`. Cached startup and online refresh retain this metadata. Unknown capabilities keep the existing defaults; the extension does not infer extra thinking tiers.

Token limits must be positive safe integers. Invalid limits fall through to the next alias or the existing defaults. Names must be nonempty strings; unsupported entries in `input` are ignored.

Costs use **prices per one million tokens**, matching Pi's `cost` fields:

| Pi cost field | Model-list fields, in precedence order |
| --- | --- |
| `input` | `cost.input`, `pricing.input_per_million` |
| `output` | `cost.output`, `pricing.output_per_million` |
| `cacheRead` | `cost.cacheRead`, `cost.cache_read`, `pricing.cache_read_input_per_million` |
| `cacheWrite` | `cost.cacheWrite`, `cost.cache_write`, `pricing.cache_creation_input_per_million` |

Only finite, nonnegative numbers are accepted; zero is a valid price. Missing or invalid prices default to zero. Prices in other units, long-context tiers, and modality-specific prices are not mapped to these four fields. Use `modelOverrides` for model-specific adjustments.

After upgrading, run `/config:model-discovery-refresh` to replace older cached defaults with the advertised metadata.

## Uninstall

```bash
pi remove pi-models-discovery
```

After removal, providers fall back to the static configuration in models.json (handwritten `models`, or none).
