import assert from "node:assert/strict";
import test from "node:test";
import {
  composeSpec,
  compositionAvailability,
  coreSupportsComposition,
  resolveComposition,
  validateCandidates,
  type CompositionEvent,
} from "../src/compose.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";
import { createTypesafeFetch, shapeTypesafeResponse, TYPESAFE_ENDPOINT } from "../src/typesafe.ts";

/** A candidate that the composer can legitimately place. */
const boxCandidate = {
  id: "panel",
  description: "Outer container for the panel.",
  root: true,
  element: { type: "Box", props: { flexDirection: "column", gap: 1 } },
};

/** A leaf candidate bound to initial state. */
const textCandidate = {
  id: "title",
  description: "Panel title text.",
  element: { type: "Text", props: { text: { $state: "/title" }, bold: true } },
};

test("the pinned core still exports the experimental composer", async () => {
  assert.equal(await coreSupportsComposition(), true);
});

test("validateCandidates reports missing ids, duplicates and unknown components", () => {
  assert.deepEqual(validateCandidates([boxCandidate, textCandidate]), []);

  const issues = validateCandidates([
    { id: "", description: "d", element: { type: "Box" } },
    { id: "dup", description: "", element: { type: "NotAComponent" } },
    { id: "dup", description: "d", element: { type: "Text" } },
    { id: "noType", description: "d", element: {} },
  ]);
  const joined = issues.join("\n");
  assert.match(joined, /no "id"/);
  assert.match(joined, /no description/);
  assert.match(joined, /unknown component "NotAComponent"/);
  assert.match(joined, /"dup" is duplicated/);
  assert.match(joined, /has no element.type/);
});

test("validateCandidates refuses an empty candidate list", () => {
  assert.match(validateCandidates([]).join("\n"), /No candidates were provided/);
});

test("compositionAvailability requires the config flag and a usable key", () => {
  assert.deepEqual(
    compositionAvailability({ config: DEFAULT_CONFIG, env: { AI_GATEWAY_API_KEY: "k" } }),
    { available: true },
  );
  assert.deepEqual(
    compositionAvailability({ config: DEFAULT_CONFIG, env: { TYPESAFE_API_KEY: "k" } }),
    { available: true },
  );
  assert.equal(compositionAvailability({ config: DEFAULT_CONFIG, env: {} }).reason, "missingKey");
  assert.equal(
    compositionAvailability({
      config: normalizeConfig({ composition: { enabled: false } }),
      env: { AI_GATEWAY_API_KEY: "k" },
    }).reason,
    "disabled",
  );
  assert.equal(
    compositionAvailability({
      config: DEFAULT_CONFIG,
      env: { AI_GATEWAY_API_KEY: "k" },
      coreSupportsComposition: false,
    }).reason,
    "unsupportedCore",
  );
});

test("resolveComposition prefers TypeSafe in auto mode and picks the matching defaults", () => {
  const both = resolveComposition({
    config: DEFAULT_CONFIG,
    env: { TYPESAFE_API_KEY: " ts ", AI_GATEWAY_API_KEY: "gw" },
  });
  assert.deepEqual(both, {
    provider: "typesafe",
    keyEnv: "TYPESAFE_API_KEY",
    apiKey: "ts",
    model: "jev-latest",
  });

  const gatewayOnly = resolveComposition({ config: DEFAULT_CONFIG, env: { AI_GATEWAY_API_KEY: "gw" } });
  assert.deepEqual(gatewayOnly, {
    provider: "gateway",
    keyEnv: "AI_GATEWAY_API_KEY",
    apiKey: "gw",
    model: "typesafe-ai/jev",
  });

  assert.equal(resolveComposition({ config: DEFAULT_CONFIG, env: {} }), undefined);
  assert.equal(
    resolveComposition({ config: DEFAULT_CONFIG, env: { TYPESAFE_API_KEY: "   " } }),
    undefined,
    "a blank key must not count as present",
  );
});

test("an explicit provider is never silently swapped for the other one", () => {
  const typesafeOnly = normalizeConfig({ composition: { provider: "typesafe" } });
  assert.equal(
    resolveComposition({ config: typesafeOnly, env: { AI_GATEWAY_API_KEY: "gw" } }),
    undefined,
    "provider=typesafe must not fall back to the gateway",
  );
  assert.equal(
    resolveComposition({ config: typesafeOnly, env: { TYPESAFE_API_KEY: "ts" } })?.provider,
    "typesafe",
  );

  const gatewayOnly = normalizeConfig({ composition: { provider: "gateway" } });
  assert.equal(
    resolveComposition({ config: gatewayOnly, env: { TYPESAFE_API_KEY: "ts" } }),
    undefined,
    "provider=gateway must not fall back to TypeSafe",
  );
});

test("an explicit model, key variable, and endpoint override the provider defaults", () => {
  const config = normalizeConfig({
    composition: {
      provider: "typesafe",
      model: "jev-preview",
      apiKeyEnv: "MY_TS_KEY",
      endpoint: "https://example.test/eval",
    },
  });
  assert.deepEqual(resolveComposition({ config, env: { MY_TS_KEY: "k" } }), {
    provider: "typesafe",
    keyEnv: "MY_TS_KEY",
    apiKey: "k",
    model: "jev-preview",
    endpoint: "https://example.test/eval",
  });
});

/**
 * Build a fake AI Gateway that answers every question with its first offered
 * criterion (never "unavailable"), so composition runs deterministically
 * without network access.
 */
function fakeGateway(options: { status?: number; requests: unknown[] }): typeof globalThis.fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      questions?: Record<string, { criteria: Record<string, string> }>;
    };
    options.requests.push(body);
    if (options.status && options.status !== 200) {
      return new Response("nope", { status: options.status });
    }
    const answers: Record<string, { type: "choice"; choice: string }> = {};
    const confidence: Record<string, number> = {};
    for (const [name, question] of Object.entries(body.questions ?? {})) {
      const choices = Object.keys(question.criteria).filter((choice) => choice !== "unavailable");
      const choice = choices[0] ?? "unavailable";
      answers[name] = { type: "choice", choice };
      confidence[name] = 0.87;
    }
    return new Response(
      JSON.stringify({
        answers,
        providerMetadata: { typesafe: { confidence } },
        usage: { inputTokens: 42 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
}

test("composeSpec streams spec snapshots and finishes with a valid spec", async () => {
  const requests: unknown[] = [];
  const events: CompositionEvent[] = [];

  for await (const event of composeSpec({
    prompt: "Show a titled panel.",
    candidates: [boxCandidate, textCandidate],
    apiKey: "test-key",
    model: "typesafe-ai/jev",
    initialState: { title: "Deployments" },
    fetchImpl: fakeGateway({ requests }),
  })) {
    events.push(event);
  }

  const steps = events.filter((event) => event.type === "step");
  const complete = events.at(-1);
  assert.ok(steps.length >= 1, "expected at least one streamed step");
  assert.ok(complete && complete.type === "complete", "expected a terminal event");
  assert.equal(complete.stopReason, "finish");
  assert.ok(complete.spec, "expected a composed spec");
  assert.ok(complete.spec.root.length > 0);
  assert.ok(requests.length >= 1, "expected the gateway to be called");
});

test("composeSpec surfaces gateway failures instead of returning an empty spec", async () => {
  const requests: unknown[] = [];
  await assert.rejects(
    async () => {
      for await (const _event of composeSpec({
        prompt: "Show a titled panel.",
        candidates: [boxCandidate, textCandidate],
        apiKey: "test-key",
        model: "typesafe-ai/jev",
        // Candidate props that read $state must resolve, or the composer
        // rejects the candidates before it ever calls the gateway.
        initialState: { title: "Deployments" },
        fetchImpl: fakeGateway({ status: 500, requests }),
      })) {
        // Drain the generator so the failure surfaces here.
      }
    },
    /Evaluation request failed \(HTTP 500\)/,
  );
});

/**
 * Build a fake TypeSafe endpoint that answers every question with its first
 * offered criterion (never "unavailable"), so the adapter is exercised
 * end-to-end without network access.
 */
function fakeTypesafe(options: { status?: number; requests: unknown[] }): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      questions?: Record<string, { criteria: Record<string, string> }>;
    };
    options.requests.push({ url, body });
    if (options.status && options.status !== 200) {
      return new Response(JSON.stringify({ error: { message: "TypeSafe said no." } }), { status: options.status });
    }
    const answers: Record<string, { type: "choice"; choice: string; confidence: number }> = {};
    for (const [name, question] of Object.entries(body.questions ?? {})) {
      const choices = Object.keys(question.criteria).filter((choice) => choice !== "unavailable");
      answers[name] = { type: "choice", choice: choices[0] ?? "unavailable", confidence: 0.91 };
    }
    return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 77, output_tokens: 5 } });
  }) as unknown as typeof globalThis.fetch;
}

test("shapeTypesafeResponse maps TypeSafe answers onto core's expected shape", () => {
  const shaped = shapeTypesafeResponse({
    model: "jev-1.13.0",
    answers: {
      root: { type: "choice", choice: "use:panel", confidence: 1 },
      title: { type: "choice", choice: "omit", confidence: 0.5 },
    },
    usage: { input_tokens: 339, output_tokens: 44 },
  });
  assert.deepEqual(shaped.answers, {
    root: { type: "choice", choice: "use:panel" },
    title: { type: "choice", choice: "omit" },
  });
  assert.deepEqual(shaped.providerMetadata, { typesafe: { confidence: { root: 1, title: 0.5 } } });
  assert.deepEqual(shaped.usage, { inputTokens: 339 });
});

test("shapeTypesafeResponse tolerates missing confidence and usage but not missing answers", () => {
  const minimal = shapeTypesafeResponse({ answers: { root: { choice: "use:panel" } } });
  assert.deepEqual(minimal, { answers: { root: { type: "choice", choice: "use:panel" } } });
  assert.equal(minimal.providerMetadata, undefined);
  assert.equal(minimal.usage, undefined);

  // These would otherwise surface as core's opaque "invalid evaluation response".
  assert.throws(() => shapeTypesafeResponse(null), /non-object/);
  assert.throws(() => shapeTypesafeResponse({}), /no answers object/);
  assert.throws(() => shapeTypesafeResponse({ answers: { root: {} } }), /no choice for question "root"/);
  // An empty answers map is a well-formed response; core reports the unanswered
  // question itself, so the adapter must not invent an error here.
  assert.deepEqual(shapeTypesafeResponse({ answers: {} }), { answers: {} });
});

test("createTypesafeFetch posts to TypeSafe with the model and reports HTTP failures", async () => {
  const requests: unknown[] = [];
  const transport = createTypesafeFetch({
    apiKey: "ts-key",
    model: "jev-latest",
    fetchImpl: fakeTypesafe({ requests }),
  });

  const response = await transport(TYPESAFE_ENDPOINT, {
    method: "POST",
    headers: { Authorization: "Bearer ts-key" },
    body: JSON.stringify({ state: { a: 1 }, questions: { q: { type: "choice", criteria: { x: "X" } } } }),
  });
  const body = (await response.json()) as { answers: Record<string, { choice: string }> };
  assert.equal(body.answers.q.choice, "x");

  const sent = requests[0] as { url: string; body: { model: string; state: unknown } };
  assert.equal(sent.url, TYPESAFE_ENDPOINT);
  assert.equal(sent.body.model, "jev-latest");
  assert.deepEqual(sent.body.state, { a: 1 });

  const failing = createTypesafeFetch({
    apiKey: "ts-key",
    model: "jev-latest",
    fetchImpl: fakeTypesafe({ status: 401, requests: [] }),
  });
  await assert.rejects(
    () => failing(TYPESAFE_ENDPOINT, { method: "POST", body: "{}" }),
    /TypeSafe evaluation request failed \(HTTP 401\): TypeSafe said no\./,
  );
});

test("composeSpec runs end-to-end through the TypeSafe adapter", async () => {
  const requests: unknown[] = [];
  const events: CompositionEvent[] = [];

  for await (const event of composeSpec({
    prompt: "Show a titled panel.",
    candidates: [boxCandidate, textCandidate],
    apiKey: "ts-key",
    model: "jev-latest",
    provider: "typesafe",
    initialState: { title: "Deployments" },
    fetchImpl: fakeTypesafe({ requests }),
  })) {
    events.push(event);
  }

  const complete = events.at(-1);
  assert.ok(complete && complete.type === "complete", "expected a terminal event");
  assert.equal(complete.stopReason, "finish");
  assert.ok(complete.spec, "expected a composed spec");
  assert.ok(requests.length >= 1, "expected TypeSafe to be called");
  // Every request must carry the model TypeSafe requires; core's gateway body has no such field.
  for (const request of requests) {
    assert.equal((request as { body: { model: string } }).body.model, "jev-latest");
  }
  // input_tokens is folded back into core's inputTokens accounting.
  assert.equal(complete.inputTokens, 77 * requests.length);
});

test("error details are unwrapped from either nesting style", async () => {
  const detailStyle = createTypesafeFetch({
    apiKey: "k",
    model: "jev-latest",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ detail: { error_type: "authentication_error", message: "Cannot authenticate." } }), {
        status: 401,
      })) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(() => detailStyle(TYPESAFE_ENDPOINT, { method: "POST", body: "{}" }), /: Cannot authenticate\.$/);

  const plainText = createTypesafeFetch({
    apiKey: "k",
    model: "jev-latest",
    fetchImpl: (async () => new Response("upstream exploded", { status: 502 })) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(() => plainText(TYPESAFE_ENDPOINT, { method: "POST", body: "{}" }), /: upstream exploded\.$/);
});

test("an HTTP failure with an empty body still reports the status", async () => {
  const empty = createTypesafeFetch({
    apiKey: "k",
    model: "jev-latest",
    fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof globalThis.fetch,
  });
  await assert.rejects(() => empty(TYPESAFE_ENDPOINT, { method: "POST", body: "{}" }), /\(HTTP 503\)\.$/);
});
