/**
 * TypeSafe System One 客户端。
 *
 * 一次调用把 state 和全部问题一起发出去：TypeSafe 并行回答同一份 state 下的所有问题，
 * 批量提问的延迟和输入 token 都明显低于逐条提问。
 *
 * 重试策略只针对可恢复错误（429 限流、529 过载、网络故障）；鉴权失败和请求体错误直接报告，
 * 不做静默降级。整个调用共享一个超时截止时间，重试不会突破 `timeoutMs`。
 */

import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/typesafe.json", import.meta.url)));

export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const TYPESAFE_ENDPOINT_ENV = "TYPESAFE_ENDPOINT";
export const DEFAULT_TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RETRYABLE_STATUSES = new Set([429, 529]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4_000;
const MAX_ERROR_BODY_CHARS = 400;
const MILLISECONDS_PER_SECOND = 1_000;

export interface TypeSafeAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface TypeSafeUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface TypeSafeResponse {
  model?: string;
  answers: Record<string, TypeSafeAnswer>;
  usage?: TypeSafeUsage;
}

/** 一次审查里复用的 TypeSafe 连接设置；两个字段都省略时读环境变量。 */
export interface TypeSafeConnection {
  /** config.json 里配置的 API Key。 */
  apiKey?: string;
  /** config.json 里配置的端点。 */
  endpoint?: string;
}

export interface AskTypeSafeOptions {
  /** 待判断的状态；字符串、数组或 JSON 对象。 */
  state: unknown;
  /** 问题 id → TypeSafe 问题定义。一次调用里全部并行回答。 */
  questions: Record<string, unknown>;
  model: string;
  /** 单次调用（含重试）的最大耗时。 */
  timeoutMs: number;
  /** config.json 里配置的 API Key；省略时回退到环境变量。 */
  apiKey?: string;
  /** config.json 里配置的端点；省略时回退到环境变量。 */
  endpoint?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

/** 显式配置优先于环境变量：写在 config.json 里就是明确意图。 */
export function resolveTypeSafeEndpoint(env: NodeJS.ProcessEnv = process.env, configured?: string): string {
  const value = configured ?? env[TYPESAFE_ENDPOINT_ENV];
  return value && value.trim() ? value.trim() : DEFAULT_TYPESAFE_ENDPOINT;
}

export function resolveTypeSafeApiKey(env: NodeJS.ProcessEnv = process.env, configured?: string): string | undefined {
  const value = configured ?? env[TYPESAFE_API_KEY_ENV];
  return value && value.trim() ? value.trim() : undefined;
}

/** 读取响应正文用于报错；正文不可读时给出明确占位，不假装成功。 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text;
  } catch (error) {
    return i18n.t("unreadableErrorBody", { message: error instanceof Error ? error.message : String(error) });
  }
}

/** 优先使用服务端 retry-after，否则指数退避。 */
function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * MILLISECONDS_PER_SECOND, RETRY_MAX_DELAY_MS);
  }
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

/** 可被中止的等待；中止时立即结束，不把延迟算进总超时之外。 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    /** 中止时立刻结束等待；调用方随后按中止或超时报告。 */
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 收窄 unknown 为普通对象；仅此处做一次断言，其它地方走具体校验。 */
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 逐项校验一个 answer；字段不合法时直接丢弃，由调用方按「没有答案」处理。 */
function parseAnswer(value: unknown): TypeSafeAnswer | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  const answer: TypeSafeAnswer = {};
  if (typeof source.type === "string") answer.type = source.type;
  if (typeof source.choice === "string") answer.choice = source.choice;
  const noul = numberValue(source.noul);
  if (noul !== undefined) answer.noul = noul;
  const confidence = numberValue(source.confidence);
  if (confidence !== undefined) answer.confidence = confidence;
  const rawProbabilities = recordValue(source.probabilities);
  if (rawProbabilities) {
    const probabilities: Record<string, number> = {};
    for (const [key, entry] of Object.entries(rawProbabilities)) {
      const probability = numberValue(entry);
      if (probability !== undefined) probabilities[key] = probability;
    }
    answer.probabilities = probabilities;
  }
  return answer;
}

/**
 * 解析 answers 字段。响应缺少 answers 对象时直接报错，
 * 避免把「服务端返回了空结果」当成「没有规则命中」。
 */
function parseResponse(payload: unknown): TypeSafeResponse {
  const source = recordValue(payload);
  if (!source) throw new Error(i18n.t("invalidResponse", { message: i18n.t("responseNotObject") }));
  const rawAnswers = recordValue(source.answers);
  if (!rawAnswers) throw new Error(i18n.t("invalidResponse", { message: i18n.t("responseMissingAnswers") }));
  const answers: Record<string, TypeSafeAnswer> = {};
  for (const [id, entry] of Object.entries(rawAnswers)) {
    const answer = parseAnswer(entry);
    if (answer) answers[id] = answer;
  }
  const usage = recordValue(source.usage);
  let parsedUsage: TypeSafeUsage | undefined;
  if (usage) {
    const inputTokens = numberValue(usage.input_tokens);
    const outputTokens = numberValue(usage.output_tokens);
    parsedUsage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    };
  }
  return {
    ...(typeof source.model === "string" ? { model: source.model } : {}),
    answers,
    ...(parsedUsage ? { usage: parsedUsage } : {}),
  };
}

export async function askTypeSafe(options: AskTypeSafeOptions): Promise<TypeSafeResponse> {
  const env = options.env ?? process.env;
  const apiKey = resolveTypeSafeApiKey(env, options.apiKey);
  if (!apiKey) {
    throw new Error(i18n.t("missingApiKey", { env: TYPESAFE_API_KEY_ENV }));
  }
  if (options.signal?.aborted) throw new Error(i18n.t("aborted"));

  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = resolveTypeSafeEndpoint(env, options.endpoint);
  const body = JSON.stringify({ model: options.model, state: options.state, questions: options.questions });
  const deadline = Date.now() + options.timeoutMs;
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body,
          signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw new Error(i18n.t("aborted"));
        if (timedOut) throw new Error(i18n.t("timeout", { seconds: Math.round(options.timeoutMs / MILLISECONDS_PER_SECOND) }));
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(i18n.t("networkFailed", { message: error instanceof Error ? error.message : String(error) }));
        }
        await wait(Math.min(retryDelayMs(attempt, null), Math.max(0, deadline - Date.now())), signal);
        if (timedOut) throw new Error(i18n.t("timeout", { seconds: Math.round(options.timeoutMs / MILLISECONDS_PER_SECOND) }));
        continue;
      }

      if (response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          throw new Error(i18n.t("invalidResponse", { message: error instanceof Error ? error.message : String(error) }));
        }
        return parseResponse(payload);
      }

      const errorBody = await readErrorBody(response);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(i18n.t("requestFailed", { status: response.status, body: errorBody }));
      }
      const remaining = deadline - Date.now();
      const delay = Math.min(retryDelayMs(attempt, response.headers.get("retry-after")), Math.max(0, remaining));
      await wait(delay, signal);
      if (timedOut) throw new Error(i18n.t("timeout", { seconds: Math.round(options.timeoutMs / MILLISECONDS_PER_SECOND) }));
    }
    throw new Error(i18n.t("requestFailed", { status: 0, body: i18n.t("noAttemptsLeft") }));
  } finally {
    clearTimeout(timer);
  }
}
