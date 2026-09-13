/**
 * 判定结果的一行式 UI 呈现：文案与颜色都在这里决定，便于稳定测试。
 *
 * 本模块不接触 Pi 的 UI 对象；调用方负责把颜色套到主题上并写进页脚。
 */
import { i18n } from "./i18n.ts";
import { STOP_SKIP_BUDGET, type StopOutcome } from "./evaluate.ts";

/**
 * 状态行颜色。取值是 Pi 主题色的子集：
 * success 表示判定为正常结束，warning 表示已自动干预，error 表示判定失败，dim 表示本轮不再干预。
 */
export type StatusColor = "success" | "warning" | "error" | "dim";

/** 一行待展示文本及其颜色：页脚状态与提示共用这个形状。 */
export interface ColoredLine {
  /** 展示文本，含用于快速识别的前缀符号。 */
  text: string;
  /** 主题色名，由调用方转成实际 ANSI 颜色。 */
  color: StatusColor;
}

/** 只暴露 fg 的主题接口，缩小依赖面，便于测试。 */
export interface ColoredTheme {
  /** 把文本包成指定主题色的 ANSI 序列。 */
  fg(color: StatusColor, text: string): string;
}

/** 只有 TUI 模式能安全地看到 ANSI 颜色。 */
export const STATUS_COLOR_MODE = "tui";

/**
 * 按模式给一行文本上色。
 * 非 TUI 模式（RPC/print/json）原样返回，否则 ANSI 序列会变成可见乱码。
 */
export function colorizeText(line: ColoredLine, mode: string, theme: ColoredTheme): string {
  return mode === STATUS_COLOR_MODE ? theme.fg(line.color, line.text) : line.text;
}

/** 置信度展示精度：一位小数足够区分把握程度。 */
const CONFIDENCE_DECIMALS = 1;

/**
 * 把一次判定结果渲染成页脚状态行。
 * 产生结论的轮次（含「取消」「失败」）都会更新状态行，
 * 而「用户主动打断」这类不判定的轮次由调用方直接给出状态行，不走这里。
 */
export function buildStatusLine(outcome: StopOutcome): ColoredLine {
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
 * 用户主动打断（按 Esc）时的状态行。
 * 这一轮不会产生判定结论，页脚明确写出原因，避免被误读成「判定为可停止」。
 */
export function buildCanceledStatusLine(): ColoredLine {
  return { text: i18n.t("statusCanceled"), color: "dim" };
}

/**
 * 本轮以异常或中断结束时的状态行。
 * 结束原因是 error 或缺失时，无法断定是用户取消，所以不使用「已打断」这个很具体的说法。
 */
export function buildNotCompletedStatusLine(): ColoredLine {
  return { text: i18n.t("statusNotCompleted"), color: "dim" };
}
