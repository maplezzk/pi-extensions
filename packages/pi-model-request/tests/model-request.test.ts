import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
  createModelRequester,
  getProviderSessionHeaders,
  mergeProviderSessionHeaders,
  ModelRequestAuthError,
  requiresProviderSessionHeader,
  resolveModelRequestAuth,
  type ModelRequestAuth,
  type ModelRequestCompletion,
  type ModelRequestContext,
} from "../src/index.ts";

const opencodeGoModel = { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" };
const zenModel = { provider: "custom-zen", baseUrl: "https://opencode.ai/zen/v1" };
const openaiModel = { provider: "openai", baseUrl: "https://api.openai.com/v1" };

/** 请求器只读模型的 provider / baseUrl，其余字段由 base 替身忽略。 */
const TEST_MODEL = { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" } as unknown as Model<any>;
const TEST_CONTEXT = { messages: [] } as unknown as Context;
const TEST_REPLY = { role: "assistant", content: [] } as unknown as AssistantMessage;

/** 组装最小上下文；鉴权结果与 session id 都可替换。 */
function requestContext(auth: ModelRequestAuth, sessionId = "session-1"): ModelRequestContext {
  return {
    modelRegistry: { getApiKeyAndHeaders: async () => auth },
    sessionManager: { getSessionId: () => sessionId },
  };
}

test("requiresProviderSessionHeader 按 provider id 与 host 识别 opencode 系列", () => {
  assert.equal(requiresProviderSessionHeader({ provider: "opencode", baseUrl: "https://opencode.ai/zen/v1" }), true);
  assert.equal(requiresProviderSessionHeader(opencodeGoModel), true);
  // 自定义 provider id 但 baseUrl 指向 opencode 时同样需要会话头。
  assert.equal(requiresProviderSessionHeader(zenModel), true);
  assert.equal(requiresProviderSessionHeader(openaiModel), false);
  assert.equal(requiresProviderSessionHeader({ provider: "openai", baseUrl: "" }), false);
  assert.equal(requiresProviderSessionHeader({ provider: "openai", baseUrl: "not a url" }), false);
});

test("getProviderSessionHeaders 只对 opencode 系列且已知 session 时返回头", () => {
  assert.deepEqual(getProviderSessionHeaders(opencodeGoModel, "session-1"), {
    "x-opencode-session": "session-1",
    "x-opencode-client": "pi",
  });
  assert.equal(getProviderSessionHeaders(opencodeGoModel, undefined), undefined);
  assert.equal(getProviderSessionHeaders(opencodeGoModel, ""), undefined);
  assert.equal(getProviderSessionHeaders(openaiModel, "session-1"), undefined);
});

test("mergeProviderSessionHeaders 保留鉴权头且调用方的头优先", () => {
  assert.deepEqual(mergeProviderSessionHeaders(opencodeGoModel, "session-1", { authorization: "Bearer key" }), {
    "x-opencode-session": "session-1",
    "x-opencode-client": "pi",
    authorization: "Bearer key",
  });
  // 调用方显式给出的同名头覆盖会话头，与核心的合并顺序一致。
  assert.deepEqual(mergeProviderSessionHeaders(opencodeGoModel, "session-1", { "x-opencode-session": "explicit" }), {
    "x-opencode-session": "explicit",
    "x-opencode-client": "pi",
  });
  assert.deepEqual(mergeProviderSessionHeaders(openaiModel, "session-1", { authorization: "Bearer key" }), {
    authorization: "Bearer key",
  });
  assert.equal(mergeProviderSessionHeaders(openaiModel, "session-1"), undefined);
});

test("resolveModelRequestAuth 合并会话头，并原样透传鉴权失败", async () => {
  const resolved = await resolveModelRequestAuth(
    requestContext({ ok: true, apiKey: "key", headers: { "x-test": "1" }, env: { A: "1" } }),
    opencodeGoModel,
  );
  assert.deepEqual(resolved, {
    ok: true,
    apiKey: "key",
    env: { A: "1" },
    headers: {
      "x-opencode-session": "session-1",
      "x-opencode-client": "pi",
      "x-test": "1",
    },
  });

  // 非 opencode 模型不加会话头。
  const plain = await resolveModelRequestAuth(
    requestContext({ ok: true, apiKey: "key", headers: { "x-test": "1" } }),
    openaiModel,
  );
  assert.deepEqual(plain, { ok: true, apiKey: "key", headers: { "x-test": "1" } });

  const failed = await resolveModelRequestAuth(requestContext({ ok: false, error: "missing auth" }), opencodeGoModel);
  assert.deepEqual(failed, { ok: false, error: "missing auth" });
});

test("createModelRequester 把鉴权与请求头交给底层 completion", async () => {
  let receivedModel: Model<any> | undefined;
  let receivedOptions: Record<string, unknown> | undefined;
  const base: ModelRequestCompletion = async (model, _context, options) => {
    receivedModel = model;
    receivedOptions = options as Record<string, unknown>;
    return TEST_REPLY;
  };
  const request = createModelRequester(
    requestContext({ ok: true, apiKey: "key", headers: { "x-test": "1" }, env: { A: "1" } }),
    { base },
  );

  const response = await request(TEST_MODEL, TEST_CONTEXT, { maxTokens: 128, signal: undefined });
  assert.equal(response, TEST_REPLY);
  assert.equal(receivedModel, TEST_MODEL);
  assert.deepEqual(receivedOptions, {
    maxTokens: 128,
    signal: undefined,
    apiKey: "key",
    env: { A: "1" },
    headers: {
      "x-opencode-session": "session-1",
      "x-opencode-client": "pi",
      "x-test": "1",
    },
  });
});

test("createModelRequester 在鉴权解析出 baseUrl 时覆盖模型地址", async () => {
  let receivedModel: Model<any> | undefined;
  const base: ModelRequestCompletion = async (model) => {
    receivedModel = model;
    return TEST_REPLY;
  };
  const request = createModelRequester(
    requestContext({ ok: true, apiKey: "key", baseUrl: "https://gateway.example/v1" }),
    { base },
  );

  await request(TEST_MODEL, TEST_CONTEXT);
  assert.equal(receivedModel?.baseUrl, "https://gateway.example/v1");
  assert.equal(receivedModel?.provider, "opencode-go");
});

test("createModelRequester 鉴权失败时抛错，可换成调用方自己的文案", async () => {
  const base: ModelRequestCompletion = async () => TEST_REPLY;
  const ctx = requestContext({ ok: false, error: "missing auth" });

  await assert.rejects(
    createModelRequester(ctx, { base })(TEST_MODEL, TEST_CONTEXT),
    (error: unknown) => error instanceof ModelRequestAuthError && error.providerError === "missing auth",
  );

  await assert.rejects(
    createModelRequester(ctx, { base, authError: (error) => new Error(`鉴权失败：${error}`) })(TEST_MODEL, TEST_CONTEXT),
    /鉴权失败：missing auth/,
  );
});
