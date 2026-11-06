/**
 * pi-model-request — 扩展用 Pi 的模型单独发一次请求。
 *
 * Pi 的模型请求统一由核心的 streamFn 发出，鉴权解析和 provider 归属头注入都在那里完成
 * （见 `@earendil-works/pi-coding-agent` 的 core/model-runtime.js 与 core/provider-attribution.js）。
 * 扩展自己调 pi-ai 的 completeSimple / complete 时这两步得自己做，做漏一步就出问题：
 * 少了归属头，opencode / opencode-go 直接返回 `400 MissingSessionID`。
 *
 * 本包把「扩展按 Pi 核心的方式发一次模型请求」收敛成一处：解析鉴权、补齐 provider 会话头、
 * 在鉴权解析出 baseUrl 时覆盖模型地址，最后调用调用方给的 completion。
 *
 * 只复刻功能必需的部分：OpenRouter / NVIDIA / Cloudflare 的归属头受 Pi 的安装遥测开关控制，
 * 扩展侧读不到该开关，所以本包不猜、不补。
 */
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";

/** opencode 系列 API 的 host；provider id 之外再用 host 兜底识别自定义配置。 */
const OPENCODE_HOST = "opencode.ai";
/** 需要 x-opencode-session 的 opencode provider id。 */
const OPENCODE_PROVIDER_IDS = new Set(["opencode", "opencode-go"]);
/** 核心在 opencode 请求里声明的客户端标识，必须与核心保持一致。 */
const OPENCODE_CLIENT = "pi";

/** 扩展发模型请求所需的最小 Pi 上下文：解析鉴权 + 取当前 session id。 */
export type ModelRequestContext = {
  readonly modelRegistry: {
    getApiKeyAndHeaders(model: Model<Api>): Promise<ModelRequestAuth>;
  };
  readonly sessionManager: { getSessionId(): string };
};

/** 鉴权解析结果；与 Pi 的 ResolvedRequestAuth 同形，headers 已并入 provider 会话头。 */
export type ModelRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: ProviderHeaders;
      env?: Record<string, string>;
      baseUrl?: string;
    }
  | { ok: false; error: string };

/** 底层 completion 契约；Pi 的 completeSimple / complete 与测试替身都实现它。 */
export type ModelRequestCompletion<TOptions extends object = SimpleStreamOptions> = (
  model: Model<Api>,
  context: Context,
  options?: TOptions,
) => Promise<AssistantMessage>;

/** 已经备好鉴权与请求头的 completion；参数与底层 completion 一致。 */
export type ModelRequester<TOptions extends object = SimpleStreamOptions> = ModelRequestCompletion<TOptions>;

/** 未提供 authError 映射时抛出的鉴权失败错误，原始错误文本保留在 providerError。 */
export class ModelRequestAuthError extends Error {
  readonly providerError: string;

  constructor(providerError: string) {
    super(`Model request authentication failed: ${providerError}`);
    this.name = "ModelRequestAuthError";
    this.providerError = providerError;
  }
}

/** 构造模型请求器时可覆盖的行为。 */
export type ModelRequesterOptions<TOptions extends object = SimpleStreamOptions> = {
  /** 真正发请求的 completion；默认 Pi 的 completeSimple。 */
  base?: ModelRequestCompletion<TOptions>;
  /** 鉴权失败时抛出的错误；默认 ModelRequestAuthError。 */
  authError?: (providerError: string) => Error;
};

/** 判断模型是否属于需要会话头的 opencode 系列（按 provider id 或 API host）。 */
export function requiresProviderSessionHeader(model: Pick<Model<Api>, "provider" | "baseUrl">): boolean {
  return OPENCODE_PROVIDER_IDS.has(model.provider) || matchesHost(model.baseUrl, OPENCODE_HOST);
}

/** 构造核心会注入的 provider 会话头；模型不需要或没有 session 时返回 undefined。 */
export function getProviderSessionHeaders(
  model: Pick<Model<Api>, "provider" | "baseUrl">,
  sessionId: string | undefined,
): ProviderHeaders | undefined {
  if (!sessionId || !requiresProviderSessionHeader(model)) return undefined;
  return { "x-opencode-session": sessionId, "x-opencode-client": OPENCODE_CLIENT };
}

/**
 * 把会话头合并进调用方已有的头，调用方传入的头优先（与核心的合并顺序一致）。
 * 任一侧为空时返回另一侧本身，不额外包装空对象。
 */
export function mergeProviderSessionHeaders(
  model: Pick<Model<Api>, "provider" | "baseUrl">,
  sessionId: string | undefined,
  headers?: ProviderHeaders,
): ProviderHeaders | undefined {
  const sessionHeaders = getProviderSessionHeaders(model, sessionId);
  if (!sessionHeaders) return headers;
  if (!headers) return sessionHeaders;
  return { ...sessionHeaders, ...headers };
}

/**
 * 解析一次模型请求要用的鉴权与请求头。
 * 不抛错：需要自定义错误文案的调用方自己判断 ok。
 */
export async function resolveModelRequestAuth(
  ctx: ModelRequestContext,
  model: Pick<Model<Api>, "provider" | "baseUrl">,
): Promise<ModelRequestAuth> {
  // 这里只需要 provider / baseUrl，而注册表的方法要求完整模型对象。
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as Model<Api>);
  if (auth.ok === false) return auth;
  return {
    ...auth,
    headers: mergeProviderSessionHeaders(model, ctx.sessionManager.getSessionId(), auth.headers),
  };
}

/**
 * 构造一个「像 Pi 核心那样发请求」的 completion：解析鉴权、补请求头、必要时覆盖 baseUrl。
 * 调用方只需按底层 completion 的方式传模型、上下文和请求参数；
 * options 泛型跟随传入的 base，completeSimple（SimpleStreamOptions）和 complete（StreamOptions）都能直接接入。
 */
export function createModelRequester<TOptions extends object = SimpleStreamOptions>(
  ctx: ModelRequestContext,
  options: ModelRequesterOptions<TOptions> = {},
): ModelRequester<TOptions> {
  const { authError } = options;
  const base: ModelRequestCompletion<TOptions> = options.base
    ?? (completeSimple as ModelRequestCompletion<TOptions>);
  return async (model, context, requestOptions) => {
    const auth = await resolveModelRequestAuth(ctx, model);
    if (auth.ok === false) {
      throw authError ? authError(auth.error) : new ModelRequestAuthError(auth.error);
    }
    // Pi 的 completion 都接受 apiKey / headers / env，但 TOptions 是泛型，
    // TS 无法自行推出这层关系，这里显式断言。
    const mergedOptions = {
      ...requestOptions,
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
    } as TOptions;
    return base(
      auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
      context,
      mergedOptions,
    );
  };
}

/** 比较 baseUrl 的 host；baseUrl 非法时按不匹配处理，不抛错。 */
function matchesHost(baseUrl: string | undefined, expectedHost: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === expectedHost;
  } catch {
    return false;
  }
}
