import type { Spec } from "@json-render/core";
import { piCatalog } from "./pi-catalog.ts";
import {
  PROVIDER_DEFAULTS,
  type ConcreteCompositionProvider,
  type JsonRenderConfig,
} from "./config.ts";
import { TYPESAFE_ENDPOINT, createTypesafeFetch } from "./typesafe.ts";

/**
 * Catalog-constrained composition through a TypeSafe decision model.
 *
 * json-render exposes this as `experimental_composeSpec` /
 * `experimental_createEvaluator`, and both are marked experimental: they may
 * change in any release. Two consequences are load-bearing here:
 *
 * 1. `@json-render/core` is pinned to an exact version (see package.json)
 *    instead of a caret range.
 * 2. The functions are imported dynamically and feature-detected, so a future
 *    release that removes them degrades to a clear message instead of
 *    breaking the whole extension at load time.
 *
 * Two transports are supported. `gateway` uses core's built-in evaluator and
 * posts to Vercel's AI Gateway with `AI_GATEWAY_API_KEY`. `typesafe` replaces
 * the transport with a fetch adapter that posts to TypeSafe's own endpoint
 * using `TYPESAFE_API_KEY`, so composition works without a Vercel account.
 *
 * Both paths need network egress and are never exercised by tests: `composeSpec`
 * accepts an injected `fetch`.
 */

/** Default Gateway evaluation model. */
export const DEFAULT_COMPOSITION_MODEL = "typesafe-ai/jev";

/** Why composition cannot run. */
export type CompositionBlockReason = "disabled" | "missingKey" | "unsupportedCore";

/** A fully resolved composition target. */
export interface ResolvedComposition {
  /** Transport that will actually be used. */
  provider: ConcreteCompositionProvider;
  /** Environment variable the key was read from. */
  keyEnv: string;
  /** API key value. */
  apiKey: string;
  /** Evaluation model id. */
  model: string;
  /** Endpoint override for the TypeSafe transport, when configured. */
  endpoint?: string;
}

/**
 * Pick the transport, key, and model to use.
 *
 * `auto` prefers TypeSafe because it needs no Vercel account; it falls back to
 * the gateway when only a gateway key is present. An explicit provider is never
 * silently swapped for the other one: a missing key is reported as `missingKey`
 * instead of quietly changing transport.
 */
export function resolveComposition(options: {
  config: JsonRenderConfig;
  env?: NodeJS.ProcessEnv;
}): ResolvedComposition | undefined {
  const env = options.env ?? process.env;
  const composition = options.config.composition;

  /** Read the key for one provider, honoring an explicit variable override. */
  const readKey = (provider: ConcreteCompositionProvider): { keyEnv: string; apiKey: string } => {
    const keyEnv = composition.apiKeyEnv || PROVIDER_DEFAULTS[provider].keyEnv;
    const raw = env[keyEnv];
    return { keyEnv, apiKey: typeof raw === "string" ? raw.trim() : "" };
  };

  /** Finish a provider once its key is known to be present. */
  const build = (provider: ConcreteCompositionProvider, keyEnv: string, apiKey: string): ResolvedComposition => {
    const model = composition.model || PROVIDER_DEFAULTS[provider].model;
    return {
      provider,
      keyEnv,
      apiKey,
      model,
      ...(provider === "typesafe" && composition.endpoint ? { endpoint: composition.endpoint } : {}),
    };
  };

  if (composition.provider === "typesafe" || composition.provider === "gateway") {
    const { keyEnv, apiKey } = readKey(composition.provider);
    return apiKey ? build(composition.provider, keyEnv, apiKey) : undefined;
  }

  for (const provider of ["typesafe", "gateway"] as const) {
    const { keyEnv, apiKey } = readKey(provider);
    if (apiKey) return build(provider, keyEnv, apiKey);
  }
  return undefined;
}

/** Whether composition can run with the current configuration and environment. */
export interface CompositionAvailability {
  available: boolean;
  reason?: CompositionBlockReason;
}

/** One step emitted while the composer builds the tree. */
export interface CompositionStepInfo {
  /** 1-based step index. */
  index: number;
  /** Element the step added. */
  elementId: string | null;
  /** Parent element id, when known. */
  parent: string | null;
  /** Slot the element was placed in, when known. */
  slot: string | null;
  /** Evaluator confidence for this decision, when reported. */
  confidence: number | null;
  /** Milliseconds elapsed for this step. */
  elapsedMs: number;
}

/** A progress event with a renderable snapshot of the spec so far. */
export interface CompositionStepEvent {
  type: "step";
  spec: Spec;
  step: CompositionStepInfo;
}

/** Terminal event. `spec` is null when the composer produced no usable tree. */
export interface CompositionCompleteEvent {
  type: "complete";
  spec: Spec | null;
  steps: number;
  elapsedMs: number;
  inputTokens: number | null;
  stopReason: "finish" | "limit" | "unavailable";
}

/** Events yielded by `composeSpec`. */
export type CompositionEvent = CompositionStepEvent | CompositionCompleteEvent;

/** Options for one composition run. */
export interface ComposeSpecOptions {
  /** What the user asked for, in natural language. */
  prompt: string;
  /** Atomic candidate elements; the composer selects and orders them. */
  candidates: readonly unknown[];
  /** Extra app context explicitly shared with the evaluator. */
  context?: Record<string, unknown>;
  /** State model written into the resulting spec. */
  initialState?: Record<string, unknown>;
  /** Batched creation (default) or one decision at a time. */
  strategy?: "batch" | "sequential";
  /** Element budget including the root. */
  maxElements?: number;
  /** Evaluation budget. */
  maxSteps?: number;
  /** Maximum tree depth; the root counts as one. */
  maxDepth?: number;
  /** Abort signal from the tool call. */
  signal?: AbortSignal;
  /** API key for the selected transport. */
  apiKey: string;
  /** Evaluation model id. */
  model: string;
  /** Transport to use. Defaults to `gateway` (core's built-in evaluator). */
  provider?: ConcreteCompositionProvider;
  /** TypeSafe endpoint override, used when `provider` is `typesafe`. */
  endpoint?: string;
  /** Per-evaluation timeout. */
  timeoutMs?: number;
  /** Fetch implementation; injectable so tests never hit the network. */
  fetchImpl?: typeof globalThis.fetch;
}

/** Check configuration and environment before advertising the compose tool. */
export function compositionAvailability(options: {
  config: JsonRenderConfig;
  env?: NodeJS.ProcessEnv;
  /** Whether the installed core still exports the experimental API. */
  coreSupportsComposition?: boolean;
}): CompositionAvailability {
  if (!options.config.composition.enabled) return { available: false, reason: "disabled" };
  if (options.coreSupportsComposition === false) return { available: false, reason: "unsupportedCore" };
  return resolveComposition({ config: options.config, ...(options.env === undefined ? {} : { env: options.env }) })
    ? { available: true }
    : { available: false, reason: "missingKey" };
}

/** Whether the installed `@json-render/core` still exports the experimental composer. */
export async function coreSupportsComposition(): Promise<boolean> {
  const module = (await import("@json-render/core")) as Record<string, unknown>;
  return (
    typeof module.experimental_composeSpec === "function" &&
    typeof module.experimental_createEvaluator === "function"
  );
}

/** Candidate fields the composer understands; validated before the call for clearer errors. */
interface CandidateLike {
  id?: unknown;
  description?: unknown;
  element?: { type?: unknown };
}

/** Report candidates that cannot be composed, with actionable messages. */
export function validateCandidates(candidates: readonly unknown[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  if (candidates.length === 0) {
    issues.push('No candidates were provided. Pass at least one { "id", "description", "element" } entry.');
    return issues;
  }
  candidates.forEach((raw, index) => {
    const candidate = (raw ?? {}) as CandidateLike;
    const id = typeof candidate.id === "string" ? candidate.id : "";
    if (!id) issues.push(`Candidate ${index + 1} has no "id".`);
    else if (seen.has(id)) issues.push(`Candidate id "${id}" is duplicated.`);
    else seen.add(id);

    const type = candidate.element?.type;
    if (typeof type !== "string" || type.length === 0) {
      issues.push(`Candidate "${id || index + 1}" has no element.type.`);
      return;
    }
    if (!piCatalog.componentNames.includes(type)) {
      issues.push(`Candidate "${id || index + 1}" uses unknown component "${type}".`);
    }
    if (typeof candidate.description !== "string" || candidate.description.trim().length === 0) {
      issues.push(`Candidate "${id || index + 1}" has no description; the evaluator cannot judge it without one.`);
    }
  });
  return issues;
}

/** Normalize one raw step record into the fields we report. */
function stepInfo(raw: Record<string, unknown>, index: number): CompositionStepInfo {
  const elementId = raw.elementId ?? raw.id;
  return {
    index,
    elementId: typeof elementId === "string" ? elementId : null,
    parent: typeof raw.parent === "string" ? raw.parent : null,
    slot: typeof raw.slot === "string" ? raw.slot : null,
    confidence: typeof raw.confidence === "number" ? raw.confidence : null,
    elapsedMs: typeof raw.elapsedMs === "number" ? raw.elapsedMs : 0,
  };
}

/**
 * Compose a spec from candidates, yielding a renderable snapshot per step.
 *
 * Throws when the experimental API is missing from the installed core, or when
 * the evaluator or provider fails; the caller is expected to surface the
 * message and let the model fall back to authoring a spec itself.
 */
export async function* composeSpec(options: ComposeSpecOptions): AsyncGenerator<CompositionEvent> {
  const module = (await import("@json-render/core")) as Record<string, unknown>;
  const compose = module.experimental_composeSpec;
  const createEvaluator = module.experimental_createEvaluator;
  if (typeof compose !== "function" || typeof createEvaluator !== "function") {
    throw new Error(
      "The installed @json-render/core no longer exports experimental_composeSpec/experimental_createEvaluator.",
    );
  }

  const provider = options.provider ?? "gateway";
  const transport =
    provider === "typesafe"
      ? createTypesafeFetch({
          apiKey: options.apiKey,
          model: options.model,
          endpoint: options.endpoint ?? TYPESAFE_ENDPOINT,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        })
      : options.fetchImpl;

  const evaluate = (createEvaluator as (input: unknown) => unknown)({
    apiKey: options.apiKey,
    model: options.model,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    // The TypeSafe transport replaces core's gateway call entirely; core keeps
    // its own timeout handling around whatever fetch it is handed.
    ...(transport === undefined ? {} : { fetch: transport }),
  });

  const request = {
    catalog: piCatalog,
    candidates: options.candidates,
    prompt: options.prompt,
    evaluate,
    ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
    ...(options.maxElements === undefined ? {} : { maxElements: options.maxElements }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.initialState === undefined ? {} : { initialState: options.initialState }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  const stream = (compose as (input: unknown) => AsyncGenerator<Record<string, unknown>>)(request);
  let index = 0;

  for await (const event of stream) {
    if (event.type === "step" && event.spec) {
      index += 1;
      yield {
        type: "step",
        spec: event.spec as Spec,
        step: stepInfo((event.step ?? {}) as Record<string, unknown>, index),
      };
      continue;
    }
    if (event.type === "complete") {
      yield {
        type: "complete",
        spec: (event.spec ?? null) as Spec | null,
        steps: Array.isArray(event.steps) ? event.steps.length : index,
        elapsedMs: typeof event.elapsedMs === "number" ? event.elapsedMs : 0,
        inputTokens: typeof event.inputTokens === "number" ? event.inputTokens : null,
        stopReason: (event.stopReason as CompositionCompleteEvent["stopReason"]) ?? "finish",
      };
    }
  }
}
