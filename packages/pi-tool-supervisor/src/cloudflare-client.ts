import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import type { TypeSafeAnswer, TypeSafeResponse } from "./typesafe-client.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/cloudflare.json", import.meta.url)));
export const CLOUDFLARE_MODELS = ["clef-flash", "clef"] as const;
export type CloudflareModel = (typeof CLOUDFLARE_MODELS)[number];
export const DEFAULT_CLOUDFLARE_MODEL: CloudflareModel = "clef-flash";
export const DEFAULT_CLOUDFLARE_BASE_URL = "https://api.cloudflare.com/client/v4";
export const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
export const CLOUDFLARE_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
const MAX_QUESTIONS = 64;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export interface CloudflareConnection {
  baseUrl?: string;
  /** Explicit non-secret account ID takes precedence over accountIdEnv. */
  accountId?: string;
  accountIdEnv?: string;
  /** Name of the variable supplied by the trusted launcher; never a token value. */
  tokenEnv?: string;
}

export interface AskCloudflareOptions extends CloudflareConnection {
  state: unknown;
  questions: Record<string, unknown>;
  model: CloudflareModel;
  /** One deadline covers all batches, response reads, retries, and backoff. */
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** HTTPS for remote gateways; plain HTTP only for local fixtures. Never follow redirects. */
function endpoint(options: AskCloudflareOptions, accountId: string): string {
  let url: URL;
  try { url = new URL(options.baseUrl ?? DEFAULT_CLOUDFLARE_BASE_URL); }
  catch { throw new Error(i18n.t("invalidBaseUrl")); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error(i18n.t("invalidBaseUrl"));
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/accounts/${accountId}/ai/run/@cf/cloudflare/${options.model}`;
  return url.toString();
}

async function readPayload(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(i18n.t("responseTooLarge"));
  }
  if (!response.body) throw new Error(i18n.t("invalidResponse"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read().catch(() => { throw new Error(i18n.t("networkFailed")); });
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(i18n.t("responseTooLarge"));
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error(i18n.t("invalidResponse")); }
}

/** Do not expose arbitrary server messages: they can echo request data or credentials. */
function requestError(status: number, payload?: unknown): Error {
  const source = record(payload);
  const codes = Array.isArray(source?.errors)
    ? source.errors.slice(0, 5).map((entry) => record(entry)?.code)
      .filter((code): code is number => typeof code === "number" && Number.isSafeInteger(code) && code >= 0)
    : [];
  const reasonKey = status === 401 || status === 403 ? "authenticationRejected"
    : status === 451 ? "regionRejected"
      : status === 429 ? "rateLimited"
        : status === 400 || status === 422 ? "inputRejected"
          : status >= 300 && status < 400 ? "redirectRejected" : "serviceRejected";
  return new Error(i18n.t("requestFailed", {
    status, codes: codes.length ? ` (${codes.join(", ")})` : "", reason: i18n.t(reasonKey),
  }));
}

function parseAnswers(payload: unknown, questions: Record<string, unknown>, model: string): TypeSafeResponse {
  const source = record(payload);
  const rawAnswers = record(source?.answers);
  if (!rawAnswers || (source?.model !== undefined && source.model !== model)) {
    throw new Error(i18n.t("invalidResponse"));
  }
  if (Object.keys(rawAnswers).some((id) => !Object.hasOwn(questions, id))) {
    throw new Error(i18n.t("invalidAnswer"));
  }
  const answers: Record<string, TypeSafeAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(questions)) {
    const answer = record(rawAnswers[id]);
    const definition = record(question);
    if (!answer || answer.type !== definition?.type) throw new Error(i18n.t("invalidAnswer"));
    if (answer.type === "noul") {
      if (!probability(answer.noul)) throw new Error(i18n.t("invalidAnswer"));
      answers[id] = { type: "noul", noul: answer.noul };
    } else {
      const criteria = record(definition?.criteria);
      if (!criteria || typeof answer.choice !== "string" || !Object.hasOwn(criteria, answer.choice)
        || !probability(answer.confidence)) throw new Error(i18n.t("invalidAnswer"));
      answers[id] = { type: "choice", choice: answer.choice, confidence: answer.confidence };
    }
    if (answer.probabilities !== undefined) {
      const probabilities = record(answer.probabilities);
      const criteria = record(definition?.criteria);
      if (!probabilities || Object.entries(probabilities).some(([key, value]) =>
        !probability(value) || !(criteria ? Object.hasOwn(criteria, key) : ["true", "false"].includes(key)))) {
        throw new Error(i18n.t("invalidAnswer"));
      }
      answers[id].probabilities = probabilities as Record<string, number>;
    }
  }
  const usage = record(source?.usage);
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  const tokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return { model, answers, ...(usage ? { usage: {
    ...(tokenCount(inputTokens) ? { inputTokens } : {}),
    ...(tokenCount(outputTokens) ? { outputTokens } : {}),
  } } : {}) };
}

function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const dateDelay = retryAfter === null ? NaN : Date.parse(retryAfter) - Date.now();
  const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : dateDelay;
  return Math.min(4_000, Math.max(0, Number.isFinite(requested) ? requested : 500 * 2 ** (attempt - 1)));
}

async function backoff(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
  signal.throwIfAborted();
}

export async function askCloudflare(options: AskCloudflareOptions): Promise<TypeSafeResponse> {
  if (options.signal?.aborted) throw new Error(i18n.t("aborted"));
  if (!CLOUDFLARE_MODELS.includes(options.model)) throw new Error(i18n.t("invalidModel"));
  const accountIdEnv = options.accountIdEnv ?? CLOUDFLARE_ACCOUNT_ID_ENV;
  const tokenEnv = options.tokenEnv ?? CLOUDFLARE_TOKEN_ENV;
  if (!ENV_NAME.test(accountIdEnv) || !ENV_NAME.test(tokenEnv)) throw new Error(i18n.t("invalidEnvName"));
  const env = options.env ?? process.env;
  const accountId = (options.accountId ?? env[accountIdEnv])?.trim();
  if (!accountId) throw new Error(i18n.t("missingAccountId"));
  if (!/^[a-fA-F0-9]{32}$/.test(accountId)) throw new Error(i18n.t("invalidAccountId"));
  const url = endpoint(options, accountId);
  const token = env[tokenEnv]?.trim();
  if (!token) throw new Error(i18n.t("missingToken"));
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error(i18n.t("timeout"));
  const entries = Object.entries(options.questions);
  if (!entries.length || entries.some(([, question]) => !["noul", "choice"].includes(String(record(question)?.type)))) {
    throw new Error(i18n.t("invalidQuestions"));
  }
  // Preserve valid IDs. Map other IDs deterministically, avoiding all original and generated IDs.
  const reserved = new Set(entries.map(([id]) => id));
  const mapped = entries.map(([original, question], index) => {
    let id = original;
    if (!QUESTION_ID.test(id)) {
      let suffix = index;
      id = `q_${suffix}`;
      while (reserved.has(id)) id = `q_${++suffix}`;
      reserved.add(id);
    }
    return { id, original, question };
  });
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  const combined: TypeSafeResponse = { model: options.model, answers: Object.create(null) };
  try {
    for (let offset = 0; offset < mapped.length; offset += MAX_QUESTIONS) {
      signal.throwIfAborted();
      const batch = mapped.slice(offset, offset + MAX_QUESTIONS);
      const questions = Object.fromEntries(batch.map(({ id, question }) => [id, question]));
      const body = JSON.stringify({ model: options.model, state: options.state, questions });
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        signal.throwIfAborted();
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST", redirect: "manual", signal,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
          });
        } catch {
          signal.throwIfAborted();
          if (attempt === MAX_ATTEMPTS) throw new Error(i18n.t("networkFailed"));
          await backoff(retryDelay(attempt, null), signal);
          continue;
        }
        if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
          await response.body?.cancel().catch(() => undefined);
          await backoff(retryDelay(attempt, response.headers.get("retry-after")), signal);
          continue;
        }
        // Redirect bodies are never useful; no request with Authorization is sent to the target.
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          throw requestError(response.status);
        }
        let payload: unknown;
        try { payload = await readPayload(response, signal); }
        catch (error) {
          signal.throwIfAborted();
          if (!response.ok) throw requestError(response.status);
          throw error;
        }
        if (!response.ok || record(payload)?.success !== true) throw requestError(response.status, payload);
        const parsed = parseAnswers(record(payload)?.result, questions, options.model);
        for (const { id, original } of batch) combined.answers[original] = parsed.answers[id];
        if (parsed.usage) {
          combined.usage ??= {};
          for (const field of ["inputTokens", "outputTokens"] as const) {
            const value = parsed.usage[field];
            if (value !== undefined) combined.usage[field] = (combined.usage[field] ?? 0) + value;
          }
        }
        break;
      }
    }
    signal.throwIfAborted();
    return combined;
  } catch (error) {
    if (options.signal?.aborted) throw new Error(i18n.t("aborted"));
    if (controller.signal.aborted) throw new Error(i18n.t("timeout"));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
