import assert from "node:assert/strict";
import test from "node:test";
import { askTypeSafe, resolveTypeSafeApiKey, resolveTypeSafeEndpoint } from "../src/typesafe-client.ts";

process.env.PI_EXTENSIONS_LOCALE = "zh-CN";

const ENV_WITH_KEY = { TYPESAFE_API_KEY: "apik-test" };
const QUESTION = { type: "noul", instructions: "问题", criteria: { true: "是", false: "否" } };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** 读取请求体；调用方保证 askTypeSafe 发的是字符串 body。 */
function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  assert.equal(typeof init?.body, "string");
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** 断言调用失败并返回错误信息，避免每个用例重复 try/catch。 */
async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("预期调用失败，但实际成功了");
}

test("缺少 API key 时明确报错，且不发起请求", async () => {
  let requestCount = 0;
  const fetchImpl: typeof fetch = async () => {
    requestCount += 1;
    return jsonResponse({ answers: {} });
  };

  const message = await messageOf(() => askTypeSafe({
    state: { diff: "" },
    questions: { rule: QUESTION },
    model: "jev-latest",
    timeoutMs: 1000,
    env: {},
    fetchImpl,
  }));

  assert.match(message, /TYPESAFE_API_KEY/);
  assert.equal(requestCount, 0);
});

test("一次请求发全部问题，并保留合法答案", async () => {
  let sent: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    sent = requestBody(init);
    return jsonResponse({
      model: "jev-1.13.0",
      answers: {
        first: { type: "noul", noul: 0.91 },
        second: { type: "noul", noul: "0.2" },
      },
      usage: { input_tokens: 120, output_tokens: 8 },
    });
  };

  const response = await askTypeSafe({
    state: { diff: "a" },
    questions: { first: QUESTION, second: QUESTION },
    model: "jev-latest",
    timeoutMs: 1000,
    env: ENV_WITH_KEY,
    fetchImpl,
  });

  assert.deepEqual(Object.keys(sent?.questions as Record<string, unknown>), ["first", "second"]);
  assert.equal(sent?.model, "jev-latest");
  assert.deepEqual(sent?.state, { diff: "a" });
  // noul 不是数字的项不保留该字段；调用方会把它当成「没有答案」而不是 0。
  assert.equal(response.answers.first?.noul, 0.91);
  assert.equal(response.answers.second?.noul, undefined);
  assert.deepEqual(response.usage, { inputTokens: 120, outputTokens: 8 });
  assert.equal(response.model, "jev-1.13.0");
});

test("429 限流按 retry-after 重试，随后成功", async () => {
  let attempt = 0;
  const fetchImpl: typeof fetch = async () => {
    attempt += 1;
    if (attempt === 1) return jsonResponse({ error: "busy" }, 429, { "retry-after": "0" });
    return jsonResponse({ answers: { first: { type: "noul", noul: 0.5 } } });
  };

  const response = await askTypeSafe({
    state: { diff: "a" },
    questions: { first: QUESTION },
    model: "jev-latest",
    timeoutMs: 2000,
    env: ENV_WITH_KEY,
    fetchImpl,
  });

  assert.equal(attempt, 2);
  assert.equal(response.answers.first?.noul, 0.5);
});

test("鉴权失败不重试，直接带状态码和正文报告", async () => {
  let attempt = 0;
  const fetchImpl: typeof fetch = async () => {
    attempt += 1;
    return jsonResponse({ detail: "invalid key" }, 401);
  };

  const message = await messageOf(() => askTypeSafe({
    state: { diff: "a" },
    questions: { first: QUESTION },
    model: "jev-latest",
    timeoutMs: 2000,
    env: ENV_WITH_KEY,
    fetchImpl,
  }));

  assert.equal(attempt, 1);
  assert.match(message, /401/);
  assert.match(message, /invalid key/);
});

test("响应缺少 answers 对象时报错，不当作没有规则命中", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({ model: "jev-1.13.0" });

  const message = await messageOf(() => askTypeSafe({
    state: { diff: "a" },
    questions: { first: QUESTION },
    model: "jev-latest",
    timeoutMs: 1000,
    env: ENV_WITH_KEY,
    fetchImpl,
  }));

  assert.match(message, /answers/);
});

test("上级请求中止时抛中止错误，不再重试", async () => {
  const controller = new AbortController();
  let attempt = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    attempt += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };

  const pending = askTypeSafe({
    state: { diff: "a" },
    questions: { first: QUESTION },
    model: "jev-latest",
    timeoutMs: 2000,
    signal: controller.signal,
    env: ENV_WITH_KEY,
    fetchImpl,
  });
  controller.abort();
  const message = await messageOf(() => pending);

  assert.equal(attempt, 1);
  assert.match(message, /终止/);
});

test("整体超时后报告超时，而不是网络错误", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };

  const message = await messageOf(() => askTypeSafe({
    state: { diff: "a" },
    questions: { first: QUESTION },
    model: "jev-latest",
    timeoutMs: 20,
    env: ENV_WITH_KEY,
    fetchImpl,
  }));

  assert.match(message, /秒/);
});

test("endpoint 默认官方地址，可由环境变量覆盖", () => {
  assert.equal(resolveTypeSafeEndpoint({}), "https://api.typesafe.ai/v1/systemone");
  assert.equal(resolveTypeSafeEndpoint({ TYPESAFE_ENDPOINT: "http://127.0.0.1:9/v1" }), "http://127.0.0.1:9/v1");
});

test("config.json 里配的 API Key 和端点优先于环境变量", async () => {
  let url = "";
  let authorization: string | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get("Authorization");
    return jsonResponse({ answers: {} });
  };

  await askTypeSafe({
    state: { diff: "" },
    questions: { rule: QUESTION },
    model: "jev-latest",
    timeoutMs: 1000,
    apiKey: "apik-from-config",
    endpoint: "http://127.0.0.1:9/v1/systemone",
    env: { TYPESAFE_API_KEY: "apik-from-env", TYPESAFE_ENDPOINT: "http://env.example/v1" },
    fetchImpl,
  });

  assert.equal(url, "http://127.0.0.1:9/v1/systemone");
  assert.equal(authorization, "Bearer apik-from-config");
});

test("只配 API Key 时端点仍回退到环境变量", async () => {
  let url = "";
  const fetchImpl: typeof fetch = async (input) => {
    url = String(input);
    return jsonResponse({ answers: {} });
  };

  await askTypeSafe({
    state: { diff: "" },
    questions: { rule: QUESTION },
    model: "jev-latest",
    timeoutMs: 1000,
    apiKey: "apik-from-config",
    env: { TYPESAFE_ENDPOINT: "http://env.example/v1" },
    fetchImpl,
  });

  assert.equal(url, "http://env.example/v1");
});

test("API Key 解析：配置优先，未配则读环境变量", () => {
  assert.equal(resolveTypeSafeApiKey({}, "apik-config"), "apik-config");
  assert.equal(resolveTypeSafeApiKey({ TYPESAFE_API_KEY: "apik-env" }), "apik-env");
  assert.equal(resolveTypeSafeApiKey({ TYPESAFE_API_KEY: "  " }), undefined);
  assert.equal(resolveTypeSafeApiKey({}, "  "), undefined);
});
