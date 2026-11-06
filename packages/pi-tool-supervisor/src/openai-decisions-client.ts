import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import type { TypeSafeAnswer, TypeSafeResponse } from "./typesafe-client.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/openai-decisions.json", import.meta.url)));
export const DEFAULT_OPENAI_DECISIONS_MODEL = "gpt-6-luna";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_QUESTIONS = 200;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface OpenAiDecisionsConnection {
  /** API version prefix or complete Decisions URL. No credentials in the URL. */
  baseUrl?: string;
  /** Environment reference only; no inline keys are accepted. */
  apiKeyEnv?: string;
}
export interface AskOpenAiDecisionsOptions extends OpenAiDecisionsConnection {
  state: unknown;
  questions: Record<string, unknown>;
  model: string;
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
function endpoint(baseUrl: string | undefined): string {
  let url: URL;
  try { url = new URL(baseUrl ?? DEFAULT_BASE_URL); }
  catch { throw new Error(i18n.t("invalidBaseUrl")); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
    || url.username || url.password || url.search || url.hash) throw new Error(i18n.t("invalidBaseUrl"));
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/decisions") ? path : `${path}/decisions`;
  return url.toString();
}
function questionsForApi(questions: Record<string, unknown>) {
  return Object.entries(questions).map(([name, value]) => {
    const question = record(value);
    if (!question || !["noul", "choice"].includes(String(question.type)) || question.instructions === undefined) throw new Error(i18n.t("invalidQuestions"));
    const instructions = JSON.stringify({ instructions: question.instructions, ...(question.type === "noul" ? { criteria: question.criteria } : {}) });
    if (question.type === "noul") return { type: "predicate", name, instructions };
    const criteria = record(question.criteria);
    if (!criteria || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 255) throw new Error(i18n.t("invalidQuestions"));
    return { type: "choice", name, instructions, choices: Object.entries(criteria).map(([value, description]) => ({ value, description: typeof description === "string" ? description : JSON.stringify(description) })) };
  });
}
function parseAnswers(payload: unknown, questions: Record<string, unknown>, model: string): TypeSafeResponse {
  const source = record(payload);
  if (!source || !Array.isArray(source.answers) || source.answers.length !== Object.keys(questions).length) throw new Error(i18n.t("invalidResponse"));
  const answers: Record<string, TypeSafeAnswer> = Object.create(null);
  for (const value of source.answers) {
    const answer = record(value);
    if (!answer || typeof answer.name !== "string" || !Object.hasOwn(questions, answer.name) || Object.hasOwn(answers, answer.name)) throw new Error(i18n.t("invalidAnswer"));
    const question = record(questions[answer.name])!;
    if (question.type === "noul") {
      if (answer.type !== "predicate" || !probability(answer.probability)) throw new Error(i18n.t("invalidAnswer"));
      answers[answer.name] = { type: "noul", noul: answer.probability };
      continue;
    }
    if (answer.type !== "choice" || typeof answer.choice !== "string" || !probability(answer.confidence) || !Array.isArray(answer.probabilities)) throw new Error(i18n.t("invalidAnswer"));
    const criteria = record(question.criteria)!;
    const probabilities: Record<string, number> = Object.create(null);
    for (const value of answer.probabilities) {
      const entry = record(value);
      if (!entry || typeof entry.value !== "string" || !Object.hasOwn(criteria, entry.value) || Object.hasOwn(probabilities, entry.value) || !probability(entry.probability)) throw new Error(i18n.t("invalidAnswer"));
      probabilities[entry.value] = entry.probability;
    }
    if (!Object.hasOwn(criteria, answer.choice) || Object.keys(criteria).length !== Object.keys(probabilities).length
      || Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.001
      || probabilities[answer.choice] + 1e-6 < Math.max(...Object.values(probabilities))) throw new Error(i18n.t("invalidAnswer"));
    answers[answer.name] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities };
  }
  const usage = record(source.usage);
  const tokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return { model: typeof source.model === "string" ? source.model : model, answers,
    ...(usage ? { usage: { ...(tokenCount(usage.input_tokens) ? { inputTokens: usage.input_tokens } : {}), ...(tokenCount(usage.output_tokens) ? { outputTokens: usage.output_tokens } : {}) } } : {}) };
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


export async function askOpenAiDecisions(options: AskOpenAiDecisionsOptions): Promise<TypeSafeResponse> {
  if (options.signal?.aborted) throw new Error(i18n.t("aborted"));
  const url = endpoint(options.baseUrl);
  const apiKeyEnv = options.apiKeyEnv ?? "OPENAI_API_KEY";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(i18n.t("invalidEnvName"));
  const token = (options.env ?? process.env)[apiKeyEnv]?.trim();
  if (!token) throw new Error(i18n.t("missingToken"));
  if (!options.model?.trim()) throw new Error(i18n.t("invalidModel"));
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error(i18n.t("timeout"));
  const entries = Object.entries(options.questions);
  if (!entries.length) throw new Error(i18n.t("invalidQuestions"));
  // Validate the complete question set before sending the first batch.
  questionsForApi(options.questions);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  const combined: TypeSafeResponse = { model: options.model, answers: Object.create(null) };
  try {
    for (let offset = 0; offset < entries.length; offset += MAX_QUESTIONS) {
      const questions = Object.fromEntries(entries.slice(offset, offset + MAX_QUESTIONS));
      const body = JSON.stringify({ model: options.model, input: JSON.stringify(options.state), questions: questionsForApi(questions) });
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        signal.throwIfAborted();
        let response: Response;
        try {
          response = await fetchImpl(url, { method: "POST", redirect: "manual", signal,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
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
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(i18n.t("requestFailed", { status: response.status }));
        }
        const parsed = parseAnswers(await readPayload(response, signal), questions, options.model);
        Object.assign(combined.answers, parsed.answers);
        if (parsed.usage) combined.usage = { inputTokens: (combined.usage?.inputTokens ?? 0) + (parsed.usage.inputTokens ?? 0), outputTokens: (combined.usage?.outputTokens ?? 0) + (parsed.usage.outputTokens ?? 0) };
        break;
      }
    }
    signal.throwIfAborted();
    return combined;
  } catch (error) {
    if (options.signal?.aborted) throw new Error(i18n.t("aborted"));
    if (controller.signal.aborted) throw new Error(i18n.t("timeout"));
    throw error;
  } finally { clearTimeout(timer); }
}
