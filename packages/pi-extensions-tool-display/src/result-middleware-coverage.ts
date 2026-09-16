/**
 * 结果渲染中间件对工具行的覆盖。
 *
 * 中间件协议（`toolName: "*"`）的语义是「工具结果渲染时都会经过它」，但只有
 * tool-display 自己装饰过的工具才会调用 `renderResultWithMiddleware`。没有被装饰的
 * 工具（第三方扩展注册的工具、甚至没有 renderResult 的工具）拿不到中间件，调用方只
 * 能退回「往会话里追加独立 entry」的兜底显示；这类 entry 长在工具行之外，折叠类扩展
 * 收不到它，于是工具行收起了、审计行还留在原地。
 *
 * 这个模块提供把「被中间件命中、但我们还没接线的工具」补上接线所需的基线渲染：
 * 工具自带 renderResult 时保留它，没有自带渲染时复刻 Pi 的默认结果块，接线前后观感
 * 一致。
 */

import { Text } from "@earendil-works/pi-tui";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.js";
import { extractTextOutput, previewLines } from "./render-utils.js";

interface RenderTheme {
  fg(color: string, text: string): string;
}

interface ToolRenderResultOptions {
  expanded?: boolean;
  isPartial?: boolean;
}

/** Pi 在没有 renderResult 时只显示前 10 行；保持一致，接线后行数不变。 */
export const GENERIC_RESULT_PREVIEW_LINES = 10;

/**
 * 复刻 Pi 的默认结果块：纯文本预览，折叠时超出部分给展开提示。
 *
 * 只用于没有自带 renderResult 的工具——它们本来就走 Pi 的这段渲染，这里复制一份是
 * 为了让中间件有基线可挂，而不是改变这些工具的显示方式。
 */
export function renderGenericResultPreview(
  result: unknown,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
): Text {
  const output = sanitizeAnsiForThemedOutput(extractTextOutput(result as never)).replace(/\r/g, "");
  const lines = output.length > 0 ? output.split("\n") : [];
  const maxLines = options.expanded === true ? lines.length : GENERIC_RESULT_PREVIEW_LINES;
  const { shown, remaining } = previewLines(lines, maxLines);
  let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (remaining > 0) {
    text += theme.fg("muted", `\n... (${remaining} more lines, Ctrl+O to expand)`);
  }
  return new Text(text, 0, 0);
}
