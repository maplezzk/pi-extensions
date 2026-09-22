# pi-model-request

让 pi 扩展**按 Pi 核心的方式**单独发一次模型请求。

Pi 自己的模型请求统一由核心 `streamFn` 发出，鉴权解析和 provider 归属头注入都在那里完成（`@earendil-works/pi-coding-agent` 的 `core/model-runtime.js`、`core/provider-attribution.js`）。扩展直接调 `@earendil-works/pi-ai` 的 `completeSimple` / `complete` 时，这两步都得自己做，做漏一步就出问题：少了会话头，opencode / opencode-go 会返回

```
400 MissingSessionID: Request is missing x-opencode-session
```

本包把「扩展按 Pi 的方式发一次模型请求」收敛成一处：解析鉴权、补齐 provider 会话头、在鉴权解析出 baseUrl 时覆盖模型地址，最后调用你给的 completion。

[English README](./README.md)

## 安装

```bash
npm install pi-model-request
```

## 快速上手

```ts
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { createModelRequester } from "pi-model-request";

// ctx: { modelRegistry, sessionManager } —— ExtensionContext 直接满足这个形状。
const request = createModelRequester(ctx, {
  base: completeSimple, // 也可以是 complete
  authError: (error) => new Error(`鉴权失败：${error}`),
});

const response = await request(model, context, { maxTokens: 2048, signal });
```

## API

| 导出 | 说明 |
|------|------|
| `createModelRequester(ctx, options?)` | 构造一个与你传入的 `base`（默认 `completeSimple`）同签名的 completion：解析鉴权、合并 provider 会话头、应用解析出的 `baseUrl`，鉴权失败时抛错。 |
| `resolveModelRequestAuth(ctx, model)` | 只做「鉴权 + 请求头」这一步，返回 `{ ok: true, ... } \| { ok: false, error }`。调用方需要自己处理错误时（例如鉴权解析器可注入）用它。 |
| `mergeProviderSessionHeaders(model, sessionId, headers?)` | 把会话头合并进已有头。调用方传入的头优先，与核心合并顺序一致。 |
| `getProviderSessionHeaders(model, sessionId)` | 构造 `{ "x-opencode-session": sessionId, "x-opencode-client": "pi" }`；不需要时返回 `undefined`。 |
| `requiresProviderSessionHeader(model)` | 判断模型是否属于 opencode 系列（provider id 为 `opencode` / `opencode-go`，或 baseUrl 的 host 是 `opencode.ai`）。 |
| `ModelRequestAuthError` | 未提供 `authError` 映射时由 `createModelRequester` 抛出，原始错误文本保留在 `providerError`。 |

## 边界

- 只复刻 opencode 会话头。OpenRouter / NVIDIA / Cloudflare 的归属头受 Pi 的安装遥测开关控制，扩展侧读不到该开关，所以本包不猜、不补。
- 取值必须与核心保持一致（`x-opencode-client: pi`）。核心规则变化时，本包要在同一次改动里跟上。
- 只影响请求路由与归属，不是鉴权机制，也不会获得额外权限。

## License

MIT
