import {
  appendResultRenderPanel,
  isResultRenderMiddlewareActive,
  registerResultRenderMiddleware,
  type ResultMiddleware,
} from "pi-extensions-tool-display";
import { buildDistillAuditLines, createDistillAuditComponent, resolveDistillRenderConfig } from "./fallback-renderer.ts";
import { loadDistillConfig } from "./summary-utils.ts";

const DISTILL_MIDDLEWARE_ID = "pi-distill.result-renderer.v1";

function getDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const details = (result as Record<string, unknown>).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
}

const distillMiddleware: ResultMiddleware = (context, next) => {
  const details = getDetails(context.result);
  if (!details) return next();
  const render = resolveDistillRenderConfig(details, loadDistillConfig().render);
  const audit = buildDistillAuditLines(
    context.toolName,
    details,
    context.options.expanded === true,
    render,
  );
  if (!audit) return next();

  const panel = createDistillAuditComponent(audit, context.theme);
  const summarized = details.outputSummaryStatus === "summarized"
    && render.showResult
    && typeof details.summaryText === "string"
    && details.summaryText.trim().length > 0;
  if (summarized) return panel;

  return appendResultRenderPanel(next(), panel);
};

export function registerDistillToolDisplayMiddleware(): () => void {
  return registerResultRenderMiddleware({
    id: DISTILL_MIDDLEWARE_ID,
    toolName: "*",
    middleware: distillMiddleware,
  });
}

export function isDistillToolDisplayMiddlewareActive(toolName: string): boolean {
  return isResultRenderMiddlewareActive(DISTILL_MIDDLEWARE_ID, toolName);
}
