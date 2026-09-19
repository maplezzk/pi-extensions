/**
 * TypeSafe direct-evaluation adapter.
 *
 * `@json-render/core`'s experimental composer always posts to Vercel AI
 * Gateway's v4 evaluation transport, and its evaluator options expose no
 * endpoint override — only an injectable `fetch`. TypeSafe's own evaluation
 * endpoint speaks the same `{ state, questions }` protocol, so this module
 * wraps `fetch`: it rewrites the request to TypeSafe, adds the `model` field
 * TypeSafe requires, and reshapes the response into the
 * `{ answers, providerMetadata, usage }` shape core validates against.
 *
 * The gateway path stays untouched: this adapter is only installed when the
 * resolved provider is TypeSafe. `fetchImpl` is injectable so tests never touch
 * the network.
 */

/** TypeSafe's evaluation endpoint. */
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Environment variable holding a TypeSafe API key. */
export const TYPESAFE_KEY_ENV = "TYPESAFE_API_KEY";

/** TypeSafe model alias used when the configuration does not name one. */
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

/** One TypeSafe answer entry. */
interface TypesafeAnswer {
  choice?: unknown;
  confidence?: unknown;
}

/** The part of a TypeSafe response this adapter reads. */
interface TypesafeResponse {
  answers?: Record<string, TypesafeAnswer>;
  usage?: { input_tokens?: unknown };
}

/** Response body `@json-render/core` validates against its own schema. */
export interface EvaluatorResponse {
  answers: Record<string, { type: "choice"; choice: string }>;
  providerMetadata?: { typesafe: { confidence: Record<string, number> } };
  usage?: { inputTokens: number };
}

/** Read a human-readable message out of an error response body. */
async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown };
      detail?: { message?: unknown };
      message?: unknown;
    };
    // TypeSafe nests its message under `detail`; other gateways use `error` or a
    // bare `message`, so accept all three rather than printing raw JSON.
    const message = parsed.detail?.message ?? parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return text.trim().slice(0, 300);
}

/**
 * Reshape a TypeSafe response into what core expects.
 *
 * Throws rather than returning a partial object: a missing or malformed answer
 * would otherwise surface only as core's generic "invalid evaluation response",
 * which hides the real cause. Confidence and token usage are optional upstream,
 * so their absence is not an error.
 */
export function shapeTypesafeResponse(raw: unknown): EvaluatorResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("TypeSafe returned a non-object evaluation response.");
  }
  const response = raw as TypesafeResponse;
  const answersRaw = response.answers;
  if (!answersRaw || typeof answersRaw !== "object" || Array.isArray(answersRaw)) {
    throw new Error("TypeSafe returned no answers object.");
  }

  const answers: EvaluatorResponse["answers"] = {};
  const confidence: Record<string, number> = {};

  for (const [id, entry] of Object.entries(answersRaw)) {
    const choice = (entry as TypesafeAnswer | undefined)?.choice;
    if (typeof choice !== "string" || choice.length === 0) {
      throw new Error(`TypeSafe returned no choice for question "${id}".`);
    }
    answers[id] = { type: "choice", choice };
    const value = (entry as TypesafeAnswer).confidence;
    if (typeof value === "number" && Number.isFinite(value)) confidence[id] = value;
  }

  const shaped: EvaluatorResponse = { answers };
  if (Object.keys(confidence).length > 0) shaped.providerMetadata = { typesafe: { confidence } };
  const tokens = response.usage?.input_tokens;
  if (typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0) {
    shaped.usage = { inputTokens: tokens };
  }
  return shaped;
}

/**
 * Build a `fetch` that sends core's evaluation requests to TypeSafe.
 *
 * A non-2xx response is turned into a thrown error carrying TypeSafe's own
 * message, because core only checks `response.ok` and would otherwise report a
 * bare status code with no explanation.
 */
export function createTypesafeFetch(options: {
  /** TypeSafe API key. */
  apiKey: string;
  /** TypeSafe model id or alias. */
  model: string;
  /** Endpoint override, for tests. */
  endpoint?: string;
  /** Transport override, for tests. */
  fetchImpl?: typeof globalThis.fetch;
}): typeof globalThis.fetch {
  const endpoint = options.endpoint ?? TYPESAFE_ENDPOINT;
  const upstreamFetch = options.fetchImpl ?? globalThis.fetch;

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text();
    let parsed: { state?: unknown; questions?: unknown };
    try {
      parsed = JSON.parse(rawBody) as { state?: unknown; questions?: unknown };
    } catch {
      throw new Error("The evaluator request body was not valid JSON.");
    }

    const upstream = await upstreamFetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: parsed.state ?? {},
        model: options.model,
        questions: parsed.questions ?? {},
      }),
      signal: init?.signal ?? request.signal,
      cache: "no-store",
    });

    if (!upstream.ok) {
      const detail = await readErrorDetail(upstream);
      // TypeSafe's own messages usually end in a period already; avoid "..".
      const suffix = !detail ? "." : /[.!?]$/.test(detail) ? "" : ".";
      throw new Error(
        `TypeSafe evaluation request failed (HTTP ${upstream.status})${detail ? `: ${detail}` : ""}${suffix}`,
      );
    }

    const body = await upstream.json().catch(() => null);
    return Response.json(shapeTypesafeResponse(body));
  }) as typeof globalThis.fetch;
}
