import assert from "node:assert/strict";
import test from "node:test";
import {
  composeSpec,
  compositionAvailability,
  coreSupportsComposition,
  validateCandidates,
  type CompositionEvent,
} from "../src/compose.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";

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

test("compositionAvailability requires the config flag and a gateway key", () => {
  assert.deepEqual(
    compositionAvailability({ config: DEFAULT_CONFIG, env: { AI_GATEWAY_API_KEY: "k" } }),
    { available: true },
  );
  assert.equal(
    compositionAvailability({ config: DEFAULT_CONFIG, env: {} }).reason,
    "missingKey",
  );
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
