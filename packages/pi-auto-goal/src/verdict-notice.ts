/**
 * 判定结论的展示文本：文案与语义色在这里决定，便于稳定测试。
 *
 * 这里只产出一行「文本 + 颜色」，真正画到会话区（带底色的消息块、落在消息下方）
 * 由共享提示出口 pi-extensions-i18n 完成，所以本模块不接触 Pi 的 UI 对象。
 */
import { i18n } from "./i18n.ts";
import type { NoticeLevel } from "pi-extensions-i18n";
import { STOP_SKIP_BUDGET, type StopOutcome } from "./evaluate.ts";

/**
 * 判定结论的颜色：success 表示正常结束，warning 表示已自动干预，
 * error 表示判定失败，dim 表示本轮未判定或已达干预上限。
 */
export type VerdictColor = "success" | "warning" | "error" | "dim";

/** 一行待展示的判定结论。 */
export interface VerdictLine {
  /** 展示文本，含用于快速识别的前缀符号。 */
  text: string;
  /** 主题色名，由共享提示出口套到正文上。 */
  color: VerdictColor;
}

/** 置信度展示精度：一位小数足够区分把握程度。 */
const CONFIDENCE_DECIMALS = 1;

/**
 * 结论色对应的提示级别：红→error、黄→warning、其余→info。
 * 正文颜色始终由结论自身的语义色决定，级别只用来归纳提示的严重程度。
 */
export function verdictNoticeLevel(color: VerdictColor): NoticeLevel {
  if (color === "error") return "error";
  if (color === "warning") return "warning";
  return "info";
}

/**
 * 把一次判定结果渲染成结论行。
 * 产生结论的轮次（含「取消」「失败」）都会给出结论行；
 * 「用户主动打断」这类不判定的轮次由调用方改用 buildInterruptedLine。
 */
export function buildVerdictLine(outcome: StopOutcome): VerdictLine {
  switch (outcome.kind) {
    case "continue":
      return { text: i18n.t("statusContinue", { budget: outcome.budget }), color: "warning" };
    case "stop":
      return {
        text: i18n.t("statusStop", { confidence: outcome.confidence.toFixed(CONFIDENCE_DECIMALS) }),
        color: "success",
      };
    case "skipped":
      return {
        text: outcome.code === STOP_SKIP_BUDGET
          ? i18n.t("statusBudget", { budget: outcome.budget })
          : i18n.t("statusCanceled"),
        color: "dim",
      };
    case "failed":
      return { text: i18n.t("statusFailed"), color: "error" };
  }
}

/**
 * 用户主动打断（按 Esc）时的结论行。
 * 这一轮不会产生判定结论，明确写出原因，避免被误读成「判定为可停止」。
 */
export function buildInterruptedLine(): VerdictLine {
  return { text: i18n.t("statusCanceled"), color: "dim" };
}

/**
 * 本轮以异常或中断结束时的结论行。
 * 结束原因是 error 或缺失时，无法断定是用户取消，所以不使用「已打断」这个很具体的说法。
 */
export function buildNotCompletedLine(): VerdictLine {
  return { text: i18n.t("statusNotCompleted"), color: "dim" };
}
