/**
 * 判定结论的单条提示：文案、语义色和细节行都在这里决定，便于稳定测试。
 *
 * 一个有判定的轮次只产生一条提示：正文一行（如「⚖️ 判定可停止 · 置信度 92%」），
 * 理由、失败原因、发送出去的催促等细节放在 details 里，默认收起、Ctrl+O 展开，
 * 避免每轮往会话区里堆好几条提示。
 *
 * 这里不接触 Pi 的 UI 对象：真正画到会话区由共享提示出口 pi-extensions-i18n 完成。
 */
import type { NoticeLevel } from "pi-extensions-i18n";
import { i18n } from "./i18n.ts";
import { STOP_SKIP_BUDGET, type StopOutcome } from "./evaluate.ts";

/**
 * 判定结论的颜色：success 表示正常结束，warning 表示已自动干预，
 * error 表示判定失败，dim 表示本轮未判定或已达干预上限。
 */
export type VerdictColor = "success" | "warning" | "error" | "dim";

/** 一条待展示的判定结论：一行正文 + 展开才显示的细节行。 */
export interface VerdictNotice {
  /** 正文，含用于快速识别的前缀符号。 */
  text: string;
  /** 正文语义色。 */
  color: VerdictColor;
  /** 提示级别，用于归纳严重程度。 */
  level: NoticeLevel;
  /** 展开（Ctrl+O）时才显示的细节行。 */
  details: string[];
}

/** 判定模型给出的置信度区间：0 到 1。 */
const CONFIDENCE_MIN = 0;
const CONFIDENCE_MAX = 1;
/** 小数转百分比的换算系数。 */
const PERCENT_SCALE = 100;

/**
 * 置信度展示：换算成整数百分比（如 0.923 → "92%"），让「0.9」这种小数不再需要用户猜。
 * 越界值与非法值收敛到 0-100，避免渲染出 120% 或 NaN%。
 */
export function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence)) return `${CONFIDENCE_MIN}%`;
  const bounded = Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, confidence));
  return `${Math.round(bounded * PERCENT_SCALE)}%`;
}

/**
 * 结论色对应的提示级别：红→error、黄→warning、其余→info。
 * 正文颜色始终由结论自身的语义色决定，级别只用来归纳提示的严重程度。
 */
export function verdictNoticeLevel(color: VerdictColor): NoticeLevel {
  if (color === "error") return "error";
  if (color === "warning") return "warning";
  return "info";
}

/** 把理由压成单行，避免判定模型换行输出把提示块撑开。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 拼一条结论：颜色决定级别，调用方只需给正文和细节。 */
function notice(
  color: VerdictColor,
  text: string,
  details: string[],
): VerdictNotice {
  return { text, color, level: verdictNoticeLevel(color), details };
}

/**
 * 把一次判定结果渲染成结论提示。
 * 「提前停止已干预」时调用方把真正注入的催促文本传进来，放进细节供回看。
 */
export function buildVerdictNotice(outcome: StopOutcome, sentMessage?: string): VerdictNotice {
  switch (outcome.kind) {
    case "continue": {
      const details = [i18n.t("detailReason", { reason: outcome.reason })];
      if (sentMessage !== undefined) {
        details.push(i18n.t("detailSent", { message: sentMessage.trim() }));
      }
      return notice("warning", i18n.t("statusContinue", { budget: outcome.budget }), details);
    }
    case "stop":
      // 理由放进详情：默认只占一行，Ctrl+O（或在全屏模式下直接点这条提示）展开就能看到。
      return notice("success", i18n.t("statusStop", {
        confidence: formatConfidence(outcome.confidence),
      }), [i18n.t("detailReason", { reason: oneLine(outcome.reason) })]);
    case "skipped":
      return outcome.code === STOP_SKIP_BUDGET
        ? notice("dim", i18n.t("statusBudget", { budget: outcome.budget }), [
          i18n.t("detailBudget", { budget: outcome.budget }),
        ])
        : notice("dim", i18n.t("statusCanceled"), [i18n.t("detailCanceled")]);
    case "failed":
      return notice("error", i18n.t("statusFailed"), [
        i18n.t("detailError", { error: outcome.error }),
      ]);
  }
}

/**
 * 用户主动打断（按 Esc）时的结论提示。
 * 这一轮没有调用判定模型，细节里写明原因，避免被误读成「判定为可停止」。
 */
export function buildInterruptedNotice(): VerdictNotice {
  return notice("dim", i18n.t("statusCanceled"), [i18n.t("detailInterrupted")]);
}

/**
 * 本轮以异常或缺失结束时的结论提示。
 * 结束原因无法断定是用户取消，所以不使用「已打断」这个很具体的说法。
 */
export function buildNotCompletedNotice(stopReason: string | undefined): VerdictNotice {
  return notice("dim", i18n.t("statusNotCompleted"), [
    i18n.t("detailNotCompleted", { stopReason: stopReason ?? i18n.t("detailStopReasonMissing") }),
  ]);
}

/** 催促消息发送失败时的结论提示；失败必须显式报出，不静默吞掉。 */
export function buildSendFailedNotice(error: string): VerdictNotice {
  return notice("error", i18n.t("verdictSendFailed"), [
    i18n.t("detailError", { error }),
  ]);
}
