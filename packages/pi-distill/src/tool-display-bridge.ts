import { Container, type Component } from "@earendil-works/pi-tui";
import { buildDistillAuditLines, createDistillAuditComponent, resolveDistillRenderConfig } from "./fallback-renderer.ts";
import { loadDistillConfig } from "./summary-utils.ts";

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const PENDING_MIDDLEWARES_KEY = Symbol.for("pi-tool-display.pendingResultRenderMiddlewares.v1");
const DISTILL_MIDDLEWARE_ID = "pi-distill.result-renderer.v1";

type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type MiddlewareContext = {
  toolName: string;
  result: unknown;
  options: { expanded?: boolean };
  theme: RenderTheme;
};

type ResultMiddleware = (context: MiddlewareContext, next: () => unknown) => unknown;

type MiddlewareRegistration = {
  id: string;
  toolName: string;
  middleware: ResultMiddleware;
};

type ToolDisplayApi = {
  registerResultRenderMiddleware?(registration: MiddlewareRegistration): string;
  unregisterResultRenderMiddleware?(id: string): boolean;
  hasResultRenderMiddleware?(id: string): boolean;
  isResultRenderPipelineActive?(toolName: string): boolean;
};

type GlobalProtocol = typeof globalThis & {
  [TOOL_DISPLAY_API_KEY]?: ToolDisplayApi;
  [PENDING_MIDDLEWARES_KEY]?: MiddlewareRegistration[];
};

function getApi(): ToolDisplayApi | undefined {
  return (globalThis as GlobalProtocol)[TOOL_DISPLAY_API_KEY];
}

function getDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const details = (result as Record<string, unknown>).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
}

function asComponent(value: unknown): Component | undefined {
  return value && typeof value === "object" && typeof (value as Component).render === "function"
    ? value as Component
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

  const base = asComponent(next());
  if (!base) return panel;
  const container = new Container();
  container.addChild(base);
  container.addChild(panel);
  return container;
};

function queueRegistration(registration: MiddlewareRegistration): void {
  const globalProtocol = globalThis as GlobalProtocol;
  const queue = Array.isArray(globalProtocol[PENDING_MIDDLEWARES_KEY])
    ? globalProtocol[PENDING_MIDDLEWARES_KEY]!
    : [];
  const index = queue.findIndex((entry) => entry?.id === registration.id);
  if (index >= 0) queue[index] = registration;
  else queue.push(registration);
  globalProtocol[PENDING_MIDDLEWARES_KEY] = queue;
}

export function registerDistillToolDisplayMiddleware(): () => void {
  const registration: MiddlewareRegistration = {
    id: DISTILL_MIDDLEWARE_ID,
    toolName: "*",
    middleware: distillMiddleware,
  };
  const api = getApi();
  if (typeof api?.registerResultRenderMiddleware === "function") {
    api.registerResultRenderMiddleware(registration);
  } else {
    queueRegistration(registration);
  }

  return () => {
    getApi()?.unregisterResultRenderMiddleware?.(DISTILL_MIDDLEWARE_ID);
    const queue = (globalThis as GlobalProtocol)[PENDING_MIDDLEWARES_KEY];
    if (!Array.isArray(queue)) return;
    const index = queue.findIndex((entry) => entry?.id === DISTILL_MIDDLEWARE_ID);
    if (index >= 0) queue.splice(index, 1);
  };
}

export function isDistillToolDisplayMiddlewareActive(toolName: string): boolean {
  const api = getApi();
  return api?.hasResultRenderMiddleware?.(DISTILL_MIDDLEWARE_ID) === true
    && api.isResultRenderPipelineActive?.(toolName) === true;
}
