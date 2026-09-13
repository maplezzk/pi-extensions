/**
 * 判定模型接入层：解析用哪个模型、取鉴权信息、发起 completion 调用。
 *
 * 模型类型与鉴权细节都收在本模块，判定流程只依赖 verdict.ts 的窄接口。
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";
import {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  STOP_REASON_LENGTH,
  type JudgeInvoker,
  type JudgeResponse,
} from "./verdict.ts";
import type { AutoGoalConfig } from "./config.ts";

/**
 * 判定调用的思考强度。
 * 判定只是一次短分类，思考会先花掉输出预算；
 * Pi 会把该值收敛到模型支持的最低档，不支持关闭思考的模型也不会报错。
 */
const JUDGE_REASONING_LEVEL = "minimal";
/** 输出被截断时，用翻倍预算重试一次；仍失败则按错误上报。 */
const TRUNCATION_RETRY_MULTIPLIER = 2;

/** Pi 的模型对象类型；对外暴露以便调用方构造判定来源。 */
export type PiModel = Parameters<typeof completeSimple>[0];

/** 鉴权结果；ok 为 false 时判定不可执行。 */
export type JudgeAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

/**
 * 模型解析所需的最小字段；JudgeModelSource 在它之上增加鉴权解析。
 * 泛型化后测试可以用简单值验证解析逻辑，无需构造真实模型对象。
 */
export interface JudgeModelResolution<T> {
  /** 配置里指定的模型标识；空字符串表示复用当前会话模型。 */
  configuredModel: string;
  /** 当前会话模型；未选择模型时为 undefined。 */
  sessionModel: T | undefined;
  /** 按 provider 与 modelId 查找模型。 */
  findModel: (provider: string, modelId: string) => T | undefined;
}

/** 判定模型来源：决定用哪个模型、如何鉴权；测试可以直接构造。 */
export interface JudgeModelSource extends JudgeModelResolution<PiModel> {
  /** 取指定模型的鉴权信息。 */
  resolveAuth: (model: PiModel) => Promise<JudgeAuth>;
}

/** 底层 completion 契约；Pi 的 complete 与测试替身都实现它。 */
export type JudgeCompletion = (options: {
  /** 判定模型。 */
  model: PiModel;
  /** 系统提示词。 */
  systemPrompt: string;
  /** 用户提示词。 */
  userPrompt: string;
  /** 已解析出的鉴权信息。 */
  auth: Extract<JudgeAuth, { ok: true }>;
  /** 输出 token 上限。 */
  maxTokens: number;
  /** 中止信号。 */
  signal?: AbortSignal;
}) => Promise<JudgeResponse>;


/** 拼接响应里的文本块，忽略思考块与工具调用块。 */
function extractResponseText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** 汇总响应内容块（如 thinking:174），用于空响应时说明模型到底返回了什么。 */
function summarizeParts(
  content: ReadonlyArray<{ type: string; text?: string; thinking?: string }>,
): string[] {
  return content.map((part) => `${part.type}:${(part.text ?? part.thinking ?? "").length}`);
}

/**
 * 解析要使用的判定模型：配置了 model 就按 provider/modelId 查找，否则用当前会话模型。
 * 泛型形式便于用简单值测试解析逻辑，无需构造真实模型对象。
 */
export function resolveJudgeModel<T>(source: JudgeModelResolution<T>): T | undefined {
  const configured = source.configuredModel.trim();
  if (!configured) return source.sessionModel;
  const separator = configured.indexOf("/");
  return source.findModel(configured.slice(0, separator), configured.slice(separator + 1));
}

/** 把 Pi 的扩展上下文包装成判定模型来源。 */
export function createJudgeModelSource(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  config: AutoGoalConfig,
): JudgeModelSource {
  return {
    configuredModel: config.model,
    sessionModel: ctx.model,
    findModel: (provider: string, modelId: string) => ctx.modelRegistry.find(provider, modelId),
    resolveAuth: (model: PiModel) => ctx.modelRegistry.getApiKeyAndHeaders(model),
  };
}

/**
 * 默认 completion：用 Pi 的 completeSimple 发一次判定请求。
 * 这里固定使用 Pi 的 completeSimple；需要替换实现时注入自己的 JudgeCompletion。
 */
export const piJudgeCompletion: JudgeCompletion = async ({
  model,
  systemPrompt,
  userPrompt,
  auth,
  maxTokens,
  signal,
}) => {
  const response = await completeSimple(
    model,
    {
      systemPrompt,
      messages: [{
        role: "user",
        content: [{ type: "text", text: userPrompt }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens,
      reasoning: JUDGE_REASONING_LEVEL,
      signal,
    },
  );
  return {
    text: extractResponseText(response.content),
    stopReason: response.stopReason,
    errorMessage: response.errorMessage,
    partTypes: summarizeParts(response.content),
  };
};

/**
 * 计算本次判定使用的输出预算：取配置值与模型输出上限的较小值。
 * 配置默认值本身不预留额度，只在真的需要时（重试）才翻倍并重新收敛到模型上限。
 */
export function resolveJudgeMaxTokens(model: PiModel, configured: number): number {
  return Math.max(1, Math.min(model.maxTokens, configured));
}

/** 判断响应是否为「被输出预算截断且没有任何文本」这种可重试的失败。 */
function isTruncatedWithoutText(response: JudgeResponse): boolean {
  return response.stopReason === STOP_REASON_LENGTH && response.text.trim() === "";
}

/**
 * 用判定模型来源与 completion 组装判定调用。
 * 模型不存在或鉴权失败时直接抛错，由上层报告给用户，不静默跳过；
 * 输出被截断且没有文本时，加大预算重试一次，避免一次偶发的截断就丢掉判定。
 */
export function createJudgeModelInvoker(options: {
  /** 模型来源。 */
  source: JudgeModelSource;
  /** 可替换的底层 completion。 */
  completion?: JudgeCompletion;
  /** 判定输出 token 上限；默认取模型上限。 */
  maxTokens?: number;
}): JudgeInvoker {
  const { source, completion = piJudgeCompletion } = options;
  return async ({ snapshot, signal }) => {
    const model = resolveJudgeModel(source);
    if (model === undefined) {
      throw new Error(i18n.t("judgeModelMissing", {
        model: source.configuredModel || i18n.t("judgeModelCurrentFallback"),
      }));
    }
    const auth = await source.resolveAuth(model);
    if (auth.ok === false) throw new Error(i18n.t("judgeAuthFailed", { error: auth.error }));

    const request = {
      model,
      systemPrompt: buildJudgeSystemPrompt(),
      userPrompt: buildJudgeUserPrompt(snapshot),
      auth,
      signal,
    };
    const maxTokens = resolveJudgeMaxTokens(model, options.maxTokens ?? model.maxTokens);
    const response = await completion({ ...request, maxTokens });
    if (!isTruncatedWithoutText(response)) return response;

    const retryMaxTokens = resolveJudgeMaxTokens(model, maxTokens * TRUNCATION_RETRY_MULTIPLIER);
    if (retryMaxTokens <= maxTokens) return response;
    return completion({ ...request, maxTokens: retryMaxTokens });
  };
}
