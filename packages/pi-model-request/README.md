# pi-model-request

Issue a one-off model request from a pi extension **the same way Pi core does**.

Pi sends its own model requests through the core `streamFn`, which resolves auth and injects provider attribution headers (`core/model-runtime.js`, `core/provider-attribution.js` in `@earendil-works/pi-coding-agent`). An extension that calls `completeSimple` / `complete` from `@earendil-works/pi-ai` has to do both steps itself, and missing one breaks the request: without the session header, opencode / opencode-go answers

```
400 MissingSessionID: Request is missing x-opencode-session
```

This package collapses "make a model request from an extension, the way Pi does" into one place: resolve auth, add the provider session headers, override the model base URL when auth resolves one, then call the completion you supply.

[中文文档](./README.zh-CN.md)

## Install

```bash
npm install pi-model-request
```

## Quick start

```ts
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createModelRequester } from "pi-model-request";

// ctx: { modelRegistry, sessionManager } — an ExtensionContext satisfies this.
const request = createModelRequester(ctx, {
  base: completeSimple, // or `complete`
  authError: (error) => new Error(`Summarizer authentication failed: ${error}`),
});

const response = await request(model, context, { maxTokens: 2048, signal });
```

## API

| Export | Description |
|--------|-------------|
| `createModelRequester(ctx, options?)` | Builds a completion with the same signature as the one you pass in `base` (default `completeSimple`). It resolves auth, merges the provider session headers, applies a resolved `baseUrl`, and throws on auth failure. |
| `resolveModelRequestAuth(ctx, model)` | The auth + header step on its own, as a `{ ok: true, ... } \| { ok: false, error }` result. Use it when the caller needs its own error handling (for example an injected auth resolver). |
| `mergeProviderSessionHeaders(model, sessionId, headers?)` | Merges the session headers into existing headers. Caller-supplied headers win, matching core merge order. |
| `getProviderSessionHeaders(model, sessionId)` | Builds `{ "x-opencode-session": sessionId, "x-opencode-client": "pi" }`, or `undefined` when not needed. |
| `requiresProviderSessionHeader(model)` | Whether the model belongs to the opencode family (provider id `opencode` / `opencode-go`, or an `opencode.ai` base URL host). |
| `ModelRequestAuthError` | Thrown by `createModelRequester` when no `authError` mapper is given; the provider error text is kept in `providerError`. |

## Scope

- Only the opencode session headers are replicated. OpenRouter / NVIDIA / Cloudflare attribution headers are gated by Pi's install-telemetry setting, which an extension cannot read, so this package deliberately does not guess.
- Values must stay identical to core (`x-opencode-client: pi`). When core changes its rules, update this package in the same change.
- This affects request routing and attribution only. It is not an authentication mechanism and grants no extra access.

## License

MIT
