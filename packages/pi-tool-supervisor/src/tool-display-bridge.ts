import {
  appendResultRenderPanel,
  isResultRenderMiddlewareActive,
  registerResultRenderMiddleware,
  type ResultMiddleware,
} from "pi-extensions-tool-display";
import { buildSupervisorAuditLines, createSupervisorAuditComponent } from "./fallback-renderer.ts";

const SUPERVISOR_MIDDLEWARE_ID = "pi-tool-supervisor.result-renderer.v1";
/** Reads the compatibility audit from any tool result details object. */
function getAudit(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const audit = (details as Record<string, unknown>).fileEditReview;
  return audit && typeof audit === "object" && !Array.isArray(audit)
    ? audit as Record<string, unknown>
    : undefined;
}

const DIAGNOSTIC_AUDIT_STATUSES = new Set(["rejected", "failed"]);

/** Returns whether the audit should replace raw diagnostic tool output in the TUI. */
function isDiagnosticAudit(audit: Record<string, unknown>): boolean {
  return typeof audit.status === "string" && DIAGNOSTIC_AUDIT_STATUSES.has(audit.status);
}

/** Renders supervisor panels for every tool carrying a valid audit. */
const supervisorMiddleware: ResultMiddleware = (context, next) => {
  const audit = getAudit(context.result);
  if (!audit) return next();
  const rendered = buildSupervisorAuditLines(
    context.toolName,
    audit,
    context.options.expanded === true,
  );
  if (!rendered) return next();

  const panel = createSupervisorAuditComponent(rendered, context.theme);
  // The full diagnostic remains in result.content for the model, while the
  // TUI shows the audit panel and the notify toast instead of printing it as
  // ordinary tool output in the editor area.
  return isDiagnosticAudit(audit) ? panel : appendResultRenderPanel(next(), panel);
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
