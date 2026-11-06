import test from "node:test";
import assert from "node:assert/strict";
import { askOpenAiDecisions } from "../src/openai-decisions-client.ts";
process.env.PI_EXTENSIONS_LOCALE = "en-US";
const options = {
  state: { diff: "+try { run(); } catch {}" },
  questions: { violation: { type: "noul", instructions: "Does the diff swallow errors?", criteria: { true: "An empty catch ignores the error.", false: "The error is handled or propagated." } } },
  model: "gpt-6-luna", timeoutMs: 1000,
  baseUrl: "https://gateway.example.com/openai/v1", apiKeyEnv: "REVIEW_KEY", env: { REVIEW_KEY: "synthetic-key" },
};
const success = () => new Response(JSON.stringify({ model: "gpt-6-luna", answers: [{ type: "predicate", name: "violation", probability: 0.97 }], usage: { input_tokens: 40, output_tokens: 0 } }));

test("configured gateway receives native Decisions questions and returns probabilities and usage", async () => {
  const result = await askOpenAiDecisions({ ...options, fetchImpl: async (url, init) => {
    assert.equal(String(url), "https://gateway.example.com/openai/v1/decisions");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-key");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(JSON.parse(body.input), options.state);
    assert.equal(body.questions[0].type, "predicate");
    assert.equal(body.questions[0].name, "violation");
    assert.match(body.questions[0].instructions, /empty catch/);
    return success();
  } });
  assert.equal(result.answers.violation.noul, 0.97);
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 0 });
});

test("native line choices retain the full probability distribution and a complete URL is accepted", async () => {
  const result = await askOpenAiDecisions({ ...options, baseUrl: "https://gateway.example.com/openai/v1/decisions/",
    questions: { line: { type: "choice", instructions: "Locate the violation.", criteria: { "2": "Empty catch.", none: "No changed line." } } },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://gateway.example.com/openai/v1/decisions");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.questions[0].choices, [{ value: "2", description: "Empty catch." }, { value: "none", description: "No changed line." }]);
      return new Response(JSON.stringify({ answers: [{ type: "choice", name: "line", choice: "2", confidence: 0.98, probabilities: [{ value: "2", probability: 0.99 }, { value: "none", probability: 0.01 }] }] }));
    } });
  assert.equal(result.answers.line.choice, "2");
  assert.equal(result.answers.line.probabilities?.["2"], 0.99);
});

test("large rule sets are batched at the API limit without losing names or token accounting", async () => {
  const counts: number[] = [];
  const result = await askOpenAiDecisions({ ...options, questions: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`rule_${i}`, options.questions.violation])),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); counts.push(body.questions.length);
      return new Response(JSON.stringify({ answers: body.questions.map((q: { name: string }) => ({ type: "predicate", name: q.name, probability: 0.01 })), usage: { input_tokens: 10, output_tokens: 0 } }));
    } });
  assert.deepEqual(counts, [200, 1]);
  assert.equal(Object.keys(result.answers).length, 201);
  assert.equal(result.usage?.inputTokens, 20);
});

test("authentication failures and redirects never retry or expose server bodies", async () => {
  for (const status of [302, 401, 403, 422]) {
    let requests = 0;
    await assert.rejects(askOpenAiDecisions({ ...options, fetchImpl: async (_url, init) => {
      requests++; assert.equal(init?.redirect, "manual");
      return new Response("synthetic-private-body", { status, headers: { location: "https://other.example.com" } });
    } }), (error: Error) => error.message.includes(`HTTP ${status}`) && !error.message.includes("synthetic-private-body"));
    assert.equal(requests, 1);
  }
});

test("temporary service errors retry within the same deadline", async () => {
  let requests = 0;
  const result = await askOpenAiDecisions({ ...options, fetchImpl: async () => ++requests === 1
    ? new Response("unavailable", { status: 503, headers: { "retry-after": "0" } }) : success() });
  assert.equal(result.answers.violation.noul, 0.97);
  assert.equal(requests, 2);
});

test("refusals, missing answers, invalid probabilities and oversized bodies remain explicit failures", async () => {
  for (const body of [
    { answers: [{ type: "refusal", name: "violation" }] },
    { answers: [] },
    { answers: [{ type: "predicate", name: "violation", probability: 1.1 }] },
    { answers: [{ type: "predicate", name: "other", probability: 0 }] },
  ]) await assert.rejects(askOpenAiDecisions({ ...options, fetchImpl: async () => new Response(JSON.stringify(body)) }));
  await assert.rejects(askOpenAiDecisions({ ...options, fetchImpl: async () => new Response(" ".repeat(1_048_577)) }), /1 MiB/);
});

test("missing credentials, invalid gateway URLs and cancelled requests do not reach the service", async () => {
  const fetchImpl: typeof fetch = async () => { throw new Error("unexpected request"); };
  await assert.rejects(askOpenAiDecisions({ ...options, env: {}, fetchImpl }), /key/i);
  await assert.rejects(askOpenAiDecisions({ ...options, baseUrl: "http://remote.example.com/v1", fetchImpl }), /HTTPS/);
  await assert.rejects(askOpenAiDecisions({ ...options, signal: AbortSignal.abort(), fetchImpl }), /cancelled/);
  await assert.rejects(askOpenAiDecisions({ ...options, timeoutMs: 15, fetchImpl: async (_url, init) => {
    await new Promise((resolve) => init?.signal?.addEventListener("abort", resolve, { once: true }));
    throw new Error("aborted request");
  } }), /timed out/);
});
