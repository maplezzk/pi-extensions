/**
 * 一次停止判定的编排结果：把「该不该催」「为什么没催」收敛成一个显式返回值。
 *
 * 本模块不接触 UI、会话发送与模型接入，只负责超时、预算与阈值判断，便于稳定测试。
 */
import { i18n } from "./i18n.ts";
import type { AutoGoalConfig } from "./config.ts";
import { formatBudget, hasContinueBudget } from "./guard.ts";
import { renderContinueMessage } from "./continue-message.ts";
import type { StopVerdict, StopVerdictRequester } from "./verdict.ts";
import type { TurnSnapshot } from "./session-context.ts";

/** 秒到毫秒换算。 */
const MILLISECONDS_PER_SECOND = 1000;

/** 判定请求的中止控制句柄。 */
export interface JudgeAbortHandle {
  /** 传给模型调用的中止信号。 */
  signal: AbortSignal;
  /** 本次中止是否由超时触发。 */
  hasTimedOut: () => boolean;
  /** 释放定时器与父级监听，必须在请求结束后调用。 */
  dispose: () => void;
}

/**
 * 创建判定请求的中止句柄：到点中止，并向外暴露「是否为超时」。
 * 父级 signal 中止时同样中止子请求，用于会话被中断的场景。
 */
export function createJudgeAbortHandle(limitMs: number, parentSignal?: AbortSignal): JudgeAbortHandle {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limitMs);
  const abortFromParent = () => controller.abort();
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  return {
    signal: controller.signal,
    hasTimedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

/** 跳过判定的原因码：自动干预预算用尽。 */
export const STOP_SKIP_BUDGET = "budget" as const;

/** 跳过判定的原因码；调用方据此决定是否提示。 */
export type StopSkipCode = typeof STOP_SKIP_BUDGET;

/** 一次判定的结果。 */
export type StopOutcome =
  | {
    kind: "continue";
    /** 待发送的自动催促消息。 */
    message: string;
    reason: string;
    confidence: number;
    /** 形如 1/2 的预算文案。 */
    budget: string;
  }
  | { kind: "stop"; reason: string; confidence: number }
  | { kind: "skipped"; code: StopSkipCode; used: number; limit: number; budget: string }
  | { kind: "failed"; error: string };

/** 判定所需的全部输入。 */
export interface EvaluateStopRequest {
  /** 本轮快照。 */
  snapshot: TurnSnapshot;
  /** 当前生效配置。 */
  config: AutoGoalConfig;
  /** 判定流程；由入口层用模型接入层组装。 */
  judge: StopVerdictRequester;
  /** 本轮已经自动干预的次数。 */
  used: number;
  /** 外部中止信号（例如会话被中断）。 */
  signal?: AbortSignal;
}

/** 把错误对象收敛成可展示文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 调用判定流程，并把超时、鉴权、解析失败统一转成可报告的文案。 */
async function resolveVerdict({
  snapshot,
  config,
  judge,
  signal,
}: Omit<EvaluateStopRequest, "used">): Promise<{ kind: "verdict"; verdict: StopVerdict } | { kind: "error"; error: string }> {
  const handle = createJudgeAbortHandle(config.timeoutSeconds * MILLISECONDS_PER_SECOND, signal);
  try {
    const verdict = await judge({ snapshot, signal: handle.signal });
    return { kind: "verdict", verdict };
  } catch (error) {
    return {
      kind: "error",
      error: handle.hasTimedOut()
        ? i18n.t("judgeTimeout", { seconds: config.timeoutSeconds })
        : i18n.t("judgeFailed", { error: errorText(error) }),
    };
  } finally {
    handle.dispose();
  }
}

/**
 * 执行一次停止判定。
 * 预算用尽直接返回 skipped；模型调用失败返回 failed；只有高置信度的「应继续」才返回 continue。
 */
export async function evaluateStop({
  snapshot,
  config,
  judge,
  used,
  signal,
}: EvaluateStopRequest): Promise<StopOutcome> {
  if (!hasContinueBudget(config.maxAutoContinues, used)) {
    return {
      kind: "skipped",
      code: STOP_SKIP_BUDGET,
      used,
      limit: config.maxAutoContinues,
      budget: formatBudget(config.maxAutoContinues, used),
    };
  }

  if (config.forcedDecision === "continue") {
    const reason = i18n.t("forcedDecisionContinueReason");
    return {
      kind: "continue",
      message: renderContinueMessage({
        reason,
        template: config.continueMessageTemplate,
      }),
      reason,
      confidence: 1,
      budget: formatBudget(config.maxAutoContinues, used + 1),
    };
  }
  if (config.forcedDecision === "stop") {
    return {
      kind: "stop",
      reason: i18n.t("forcedDecisionStopReason"),
      confidence: 1,
    };
  }

  const judged = await resolveVerdict({ snapshot, config, judge, signal });
  if (judged.kind === "error") return { kind: "failed", error: judged.error };
  const verdict = judged.verdict;

  const budget = formatBudget(config.maxAutoContinues, used + 1);
  if (verdict.decision === "continue" && verdict.confidence >= config.confidenceThreshold) {
    return {
      kind: "continue",
      message: renderContinueMessage({ reason: verdict.reason, template: config.continueMessageTemplate }),
      reason: verdict.reason,
      confidence: verdict.confidence,
      budget,
    };
  }
  return { kind: "stop", reason: verdict.reason, confidence: verdict.confidence };
}
