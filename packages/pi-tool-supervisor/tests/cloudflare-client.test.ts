import assert from "node:assert/strict";
import test from "node:test";
import { askCloudflare, type AskCloudflareOptions } from "../src/cloudflare-client.ts";

process.env.PI_EXTENSIONS_LOCALE = "en-US";
const TOKEN = "synthetic-secret-do-not-echo";
const options: AskCloudflareOptions = {
  accountId: "a".repeat(32), model: "clef-flash", state: "Synthetic state",
  env: { CLOUDFLARE_API_TOKEN: TOKEN }, timeoutMs: 2_000,
  questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
};
const success = (answers: unknown) => new Response(JSON.stringify({ success: true, result: { answers } }));

for (const model of ["clef-flash", "clef"] as const) {
  test(`${model} uses the REST model endpoint, envelope, and usage`, async () => {
    const result = await askCloudflare({ ...options, model, fetchImpl: async (url, init) => {
      assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/@cf/cloudflare/${model}`);
      assert.equal(init?.redirect, "manual");
      assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(JSON.parse(String(init?.body)), { model, state: options.state, questions: options.questions });
      return new Response(JSON.stringify({ success: true, result: {
        model, answers: { urgent: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 123, output_tokens: 0 },
      } }));
    } });
    assert.equal(result.answers.urgent.noul, 0.8);
    assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 0 });
  });
}

test("more than 64 questions and invalid/long IDs are batched and restored without collisions", async () => {
  const ids = ["q_0", "unsafe/name", "x".repeat(101), ...Array.from({ length: 130 }, (_, i) => `rule_${i}`)];
  const batches: string[][] = [];
  const result = await askCloudflare({ ...options,
    questions: Object.fromEntries(ids.map((id) => [id, { type: "noul" }])),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const batch = Object.keys(body.questions);
      batches.push(batch);
      assert.ok(batch.every((id) => /^[A-Za-z0-9_.-]{1,100}$/.test(id)));
      return success(Object.fromEntries(batch.map((id) => [id, { type: "noul", noul: 0.2 }])));
    },
  });
  assert.deepEqual(batches.map((batch) => batch.length), [64, 64, 5]);
  assert.equal(new Set(batches.flat()).size, ids.length);
  assert.deepEqual(Object.keys(result.answers), ids);
});

for (const [name, payload] of Object.entries({
  missing: {}, unexpected: { urgent: { type: "noul", noul: 0 }, extra: { type: "noul", noul: 0 } },
  wrongType: { urgent: { type: "choice", noul: 0 } },
  range: { urgent: { type: "noul", noul: 1.1 } },
  probabilities: { urgent: { type: "noul", noul: 0.1, probabilities: { true: -1 } } },
})) {
  test(`invalid ${name} answers cannot pass`, async () => {
    await assert.rejects(askCloudflare({ ...options, fetchImpl: async () => success(payload) }), /answers/i);
  });
}

test("Choice validates candidates, confidence, and probabilities", async () => {
  const questions = { line: { type: "choice", criteria: { "1": "Line one", none: "No line" } } };
  for (const answer of [
    { type: "choice", choice: "2", confidence: 0.9 },
    { type: "choice", choice: "1", confidence: 2 },
    { type: "choice", choice: "1", confidence: 0.9, probabilities: { "2": 0.9 } },
  ]) await assert.rejects(askCloudflare({ ...options, questions, fetchImpl: async () => success({ line: answer }) }), /answers/i);
  const result = await askCloudflare({ ...options, questions, fetchImpl: async () => success({
    line: { type: "choice", choice: "1", confidence: 0.9, probabilities: { "1": 0.95, none: 0.05 } },
  }) });
  assert.equal(result.answers.line.choice, "1");
});

for (const status of [200, 401, 403, 422, 451]) {
  test(`HTTP ${status} failure envelope is safe and never retried`, async () => {
    let requests = 0;
    await assert.rejects(askCloudflare({ ...options, fetchImpl: async () => {
      requests++;
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: TOKEN }] }), { status });
    } }), (error: Error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}.*10000`));
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
    assert.equal(requests, 1);
  });
}

test("invalid JSON, bare binding responses, and oversized streaming responses fail", async () => {
  for (const body of ["{", JSON.stringify({ answers: { urgent: { type: "noul", noul: 0 } } }), " ".repeat(1_048_577)]) {
    await assert.rejects(askCloudflare({ ...options, fetchImpl: async () => new Response(body) }));
  }
  await assert.rejects(askCloudflare({ ...options, fetchImpl: async () => new Response("", {
    headers: { "content-length": "1048577" },
  }) }), /1 MiB/);
});

test("retryable HTTP errors recover, retries have a limit, and cancellation stops backoff", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    let count = 0;
    const result = await askCloudflare({ ...options, fetchImpl: async () => ++count === 1
      ? new Response("busy", { status, headers: { "retry-after": "0" } })
      : success({ urgent: { type: "noul", noul: 0.1 } }),
    });
    assert.equal(count, 2);
    assert.equal(result.answers.urgent.noul, 0.1);
  }
  let attempts = 0;
  await assert.rejects(askCloudflare({ ...options, fetchImpl: async () => {
    attempts++;
    return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
  } }), /HTTP 429/);
  assert.equal(attempts, 3);
  const parent = new AbortController();
  attempts = 0;
  const request = askCloudflare({ ...options, signal: parent.signal, fetchImpl: async () => {
    attempts++;
    setTimeout(() => parent.abort(), 5);
    return new Response("busy", { status: 429, headers: { "retry-after": "4" } });
  } });
  await assert.rejects(request, /cancelled/);
  assert.equal(attempts, 1);
});

test("timeout covers all batches and response reading; parent cancellation stops subsequent batches", async () => {
  const questions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`rule_${i}`, { type: "noul" }]));
  const parent = new AbortController();
  let requests = 0;
  await assert.rejects(askCloudflare({ ...options, questions, signal: parent.signal, fetchImpl: async (_url, init) => {
    requests++;
    parent.abort();
    return success(Object.fromEntries(Object.keys(JSON.parse(String(init?.body)).questions).map((id) => [id, { type: "noul", noul: 0 }])));
  } }), /cancelled/);
  assert.equal(requests, 1);
  await assert.rejects(askCloudflare({ ...options, timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} })) }), /timed out/);
});

test("invalid configuration and redirects never disclose credentials", async () => {
  for (const overrides of [
    { baseUrl: "http://example.com" }, { baseUrl: "https://user:password@example.com" },
    { baseUrl: "https://example.com?token=secret" }, { baseUrl: "ftp://example.com" },
    { accountId: "../other" }, { tokenEnv: "bad token" }, { env: {} },
  ]) {
    await assert.rejects(askCloudflare({ ...options, ...overrides, fetchImpl: async () => assert.fail("invalid configuration sent a request") }));
  }
  let count = 0;
  await assert.rejects(askCloudflare({ ...options, fetchImpl: async (_url, init) => {
    count++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://example.com" } });
  } }), /redirect/i);
  assert.equal(count, 1);
});
