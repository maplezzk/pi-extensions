/**
 * 提前停止判定的语言层：提示词、响应解析与判定流程组装。
 *
 * 不接触 Pi 的模型与鉴权对象，输入输出都是纯数据，便于稳定测试。
 */
import { i18n } from "./i18n.ts";
import type { TurnSnapshot } from "./session-context.ts";

/** 判定结论：应继续还是可以正常停止。 */
export type StopDecision = "continue" | "stop";

/** 判定模型返回的结构化结论。 */
export interface StopVerdict {
  /** continue 表示 agent 属于提前停止。 */
  decision: StopDecision;
  /** 0..1，表示判定模型自己的把握。 */
  confidence: number;
  /** 一句话说明缺口或可停理由。 */
  reason: string;
}

/** 合法 decision 取值。 */
const VALID_DECISIONS: readonly StopDecision[] = ["continue", "stop"];
/** 置信度下限。 */
const CONFIDENCE_MIN = 0;
/** 置信度上限。 */
const CONFIDENCE_MAX = 1;
/** 解析失败时放进错误消息的原始响应字符上限。 */
const RAW_RESPONSE_CHARS = 400;
/** 模型结束原因：请求出错。 */
const STOP_REASON_ERROR = "error";
/** 模型结束原因：请求被中止。 */
const STOP_REASON_ABORTED = "aborted";

/** 判定模型返回的原始文本响应。 */
export interface JudgeResponse {
  /** 模型输出的文本。 */
  text: string;
  /** 结束原因；error 与 aborted 视为请求失败。 */
  stopReason: string;
  /** 失败原因，仅失败时有值。 */
  errorMessage?: string;
}

/** 一次判定请求：本轮快照加上外部中止信号。 */
export interface JudgeRequest {
  /** 本轮上下文。 */
  snapshot: TurnSnapshot;
  /** 外部中止信号。 */
  signal?: AbortSignal;
}

/** 底层判定调用契约：接入不同模型只需实现这里。 */
export type JudgeInvoker = (request: JudgeRequest) => Promise<JudgeResponse>;

/** 判定流程契约：返回结构化结论，失败时抛错。 */
export type StopVerdictRequester = (request: JudgeRequest) => Promise<StopVerdict>;

/** 构造判定系统提示词。 */
export function buildJudgeSystemPrompt(): string {
  return i18n.t("judgeSystemPrompt");
}

/** 把工具轨迹渲染成提示词文本块；无调用时使用占位文案。 */
function formatToolTrace(snapshot: TurnSnapshot): string {
  return snapshot.toolTrace.length > 0
    ? snapshot.toolTrace.join("\n")
    : i18n.t("judgeToolTraceEmpty");
}

/** 构造判定用户提示词，用标签包住三段上下文，避免被当成指令。 */
export function buildJudgeUserPrompt(snapshot: TurnSnapshot): string {
  return i18n.t("judgeUserPrompt", {
    userRequest: snapshot.userRequest,
    finalOutput: snapshot.finalOutput || i18n.t("judgeFinalOutputEmpty"),
    toolTrace: formatToolTrace(snapshot),
  });
}

/**
 * 把原始响应收敛成 JSON 片段：去代码块标记，取最外层大括号内容。
 * 解析细节不对外暴露，调用方只需使用 parseJudgeVerdict。
 */
function extractJsonObject(raw: string): string | undefined {
  const text = raw.trim().replace(/^```(?:json|json5)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

/**
 * 解析判定模型的响应。
 * 无法解析、字段非法或 decision 不在枚举内时返回 undefined，调用方按「不干预」兜底。
 */
export function parseJudgeVerdict(raw: string): StopVerdict | undefined {
  const json = extractJsonObject(raw);
  if (!json) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  const decision = record.decision;
  if (typeof decision !== "string" || !VALID_DECISIONS.includes(decision as StopDecision)) {
    return undefined;
  }
  const rawConfidence = record.confidence;
  const confidence = typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
    ? Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, rawConfidence))
    : CONFIDENCE_MIN;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";

  return { decision: decision as StopDecision, confidence, reason };
}

/**
 * 用底层调用组装判定流程。
 * 结束原因为 error/aborted，或响应无法解析时显式抛错，由上层报告给用户。
 */
export function createStopVerdictRequester(invoke: JudgeInvoker): StopVerdictRequester {
  return async (request: JudgeRequest): Promise<StopVerdict> => {
    const response = await invoke(request);
    if (response.stopReason === STOP_REASON_ERROR || response.stopReason === STOP_REASON_ABORTED) {
      throw new Error(i18n.t("judgeRequestFailed", {
        error: response.errorMessage ?? response.stopReason,
      }));
    }
    const verdict = parseJudgeVerdict(response.text);
    if (!verdict) {
      const excerpt = response.text.trim().slice(0, RAW_RESPONSE_CHARS);
      throw new Error(i18n.t("judgeResponseUnparsed", {
        response: excerpt || i18n.t("judgeResponseEmpty"),
      }));
    }
    return verdict;
  };
}
