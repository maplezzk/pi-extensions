import {
  appendResultRenderPanel,
  isResultRenderMiddlewareActive,
  registerResultRenderMiddleware,
  type ResultMiddleware,
} from "pi-extensions-tool-display";
import { buildSupervisorAuditLines, createSupervisorAuditComponent } from "./fallback-renderer.ts";

const SUPERVISOR_MIDDLEWARE_ID = "pi-tool-supervisor.result-renderer.v1";
const SUPPORTED_TOOLS = new Set(["edit", "write"]);

function getAudit(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const audit = (details as Record<string, unknown>).fileEditReview;
  return audit && typeof audit === "object" && !Array.isArray(audit)
    ? audit as Record<string, unknown>
    : undefined;
}

const supervisorMiddleware: ResultMiddleware = (context, next) => {
  if (!SUPPORTED_TOOLS.has(context.toolName)) return next();
  const audit = getAudit(context.result);
  if (!audit) return next();
  const rendered = buildSupervisorAuditLines(
    context.toolName,
    audit,
    context.options.expanded === true,
  );
  if (!rendered) return next();

  const panel = createSupervisorAuditComponent(rendered, context.theme);
  return appendResultRenderPanel(next(), panel);
};

export function registerSupervisorToolDisplayMiddleware(): () => void {
  return registerResultRenderMiddleware({
    id: SUPERVISOR_MIDDLEWARE_ID,
    toolName: "*",
    middleware: supervisorMiddleware,
  });
}

export function isSupervisorToolDisplayMiddlewareActive(toolName: string): boolean {
  return isResultRenderMiddlewareActive(SUPERVISOR_MIDDLEWARE_ID, toolName);
}
