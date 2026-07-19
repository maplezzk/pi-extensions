import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { buildSupervisorAuditLines } from "./fallback-renderer.ts";

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const PENDING_MIDDLEWARES_KEY = Symbol.for("pi-tool-display.pendingResultRenderMiddlewares.v1");
const SUPERVISOR_MIDDLEWARE_ID = "pi-tool-supervisor.result-renderer.v1";
const SUPPORTED_TOOLS = new Set(["edit", "write"]);

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

function getAudit(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const audit = (details as Record<string, unknown>).fileEditReview;
  return audit && typeof audit === "object" && !Array.isArray(audit)
    ? audit as Record<string, unknown>
    : undefined;
}

function asComponent(value: unknown): Component | undefined {
  return value && typeof value === "object" && typeof (value as Component).render === "function"
    ? value as Component
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

  const panel = new Text(context.theme.fg(rendered.tone, rendered.lines.join("\n")), 0, 0);
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

export function registerSupervisorToolDisplayMiddleware(): () => void {
  const registration: MiddlewareRegistration = {
    id: SUPERVISOR_MIDDLEWARE_ID,
    toolName: "*",
    middleware: supervisorMiddleware,
  };
  const api = getApi();
  if (typeof api?.registerResultRenderMiddleware === "function") {
    api.registerResultRenderMiddleware(registration);
  } else {
    queueRegistration(registration);
  }

  return () => {
    getApi()?.unregisterResultRenderMiddleware?.(SUPERVISOR_MIDDLEWARE_ID);
    const queue = (globalThis as GlobalProtocol)[PENDING_MIDDLEWARES_KEY];
    if (!Array.isArray(queue)) return;
    const index = queue.findIndex((entry) => entry?.id === SUPERVISOR_MIDDLEWARE_ID);
    if (index >= 0) queue.splice(index, 1);
  };
}

export function isSupervisorToolDisplayMiddlewareActive(toolName: string): boolean {
  const api = getApi();
  return api?.hasResultRenderMiddleware?.(SUPERVISOR_MIDDLEWARE_ID) === true
    && api.isResultRenderPipelineActive?.(toolName) === true;
}
