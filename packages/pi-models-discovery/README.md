# pi-models-discovery

Generic model discovery extension: reads providers marked with `"discoverModels": true` in `~/.pi/agent/models.json`, requests `GET {baseUrl}/models`, and registers the discovered models automatically — no handwritten `models` array required. After the first successful discovery the model list is persisted to a local cache, so subsequent startups read the cache and **perform no network requests**.

Suitable for local/self-hosted LLM proxies (one gateway exposing many models), Ollama, vLLM, and other OpenAI-compatible services.

## Install

```bash
pi install npm:pi-models-discovery
```

## Configuration

### Option 1: interactive configuration inside pi (recommended)

```
/model-discovery
```

Interactively add / remove / rediscover providers: enter id, baseUrl, api type, apiKey (optional), display name (optional). Changes are written to models.json and take effect **immediately** (no /reload required). A backup is written to `models.json.discovery-bak` before each write.

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

`baseUrl` and `api` are required; `apiKey` is optional (omit for unauthenticated services). Multiple providers sharing the same `baseUrl+apiKey` reuse a single `/models` request.

Hand edits require `/reload` to take effect; changes made through `/model-discovery` apply immediately.

## Refreshing the cache

```
/model-discovery-refresh
```

Forces a rediscovery of every discovery provider and updates the local cache, notifying the result for each provider.

## Behavior

- **Startup (cache-first)**: when the cache hits, models are registered directly from the persisted list with zero network requests. The cache lives at `~/.pi/agent/extensions/pi-models-discovery/cache.json`. The cache is invalidated automatically when the provider configuration fingerprint (baseUrl+api+apiKey+headers+compat) changes, triggering a fresh network discovery.
- **Online refresh**: `/model-discovery-refresh`, or the `refreshModels` hook triggered when opening `/model`, rediscovers online and updates the cache.
- **Offline / fetch failure**: handwritten `models` in models.json (if any) are kept as a fallback, and an explicit warning is surfaced via in-session notify — never a silent degradation. One provider failing does not affect the others.
- **apiKey resolution** (discovery request only): supports literals and `$ENV_VAR` / `${ENV_VAR}` interpolation; `!command` values skip discovery with an explicit warning (chat requests are still resolved by pi itself and are unaffected).
- Default parameters for discovered models: `reasoning: true`, `input: ["text", "image"]`, zero cost, `contextWindow` 1M, `maxTokens` 64K, `compat.supportsDeveloperRole: false`. Provider-level `compat` is merged into every discovered model.
- Model metadata may carry `name` / `context_window` (or `contextWindow`) / `max_tokens` (or `maxTokens`); defaults are used when absent.

## Uninstall

```bash
pi remove pi-models-discovery
```

After removal, providers fall back to the static configuration in models.json (handwritten `models`, or none).
