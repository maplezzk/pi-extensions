/**
 * 判定模型接入层：解析用哪个模型、取鉴权信息、发起 completion 调用。
 *
 * 模型类型与鉴权细节都收在本模块，判定流程只依赖 verdict.ts 的窄接口。
 */
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";
import {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  type JudgeInvoker,
  type JudgeResponse,
} from "./verdict.ts";
import type { AutoGoalConfig } from "./config.ts";

/** 判定输出预算：只需要一句理由，限制输出避免浪费 token。 */
const JUDGE_MAX_TOKENS = 400;

/** Pi 的模型对象类型；对外暴露以便调用方构造判定来源。 */
export type PiModel = Parameters<typeof complete>[0];

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
 * 默认 completion：用 Pi 的 complete 发一次判定请求。
 * 这里固定使用 Pi 的 complete；需要替换实现时注入自己的 JudgeCompletion。
 */
export const piJudgeCompletion: JudgeCompletion = async ({
  model,
  systemPrompt,
  userPrompt,
  auth,
  maxTokens,
  signal,
}) => {
  const response = await complete(
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
      signal,
    },
  );
  return {
    text: extractResponseText(response.content),
    stopReason: response.stopReason,
    errorMessage: response.errorMessage,
  };
};

/**
 * 用判定模型来源与 completion 组装判定调用。
 * 模型不存在或鉴权失败时直接抛错，由上层报告给用户，不静默跳过。
 */
export function createJudgeModelInvoker(options: {
  /** 模型来源。 */
  source: JudgeModelSource;
  /** 可替换的底层 completion。 */
  completion?: JudgeCompletion;
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
    return completion({
      model,
      systemPrompt: buildJudgeSystemPrompt(),
      userPrompt: buildJudgeUserPrompt(snapshot),
      auth,
      maxTokens: JUDGE_MAX_TOKENS,
      signal,
    });
  };
}
