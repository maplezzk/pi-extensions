import { Container, type Component } from "@earendil-works/pi-tui";

export const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
export const PENDING_MIDDLEWARES_KEY = Symbol.for("pi-tool-display.pendingResultRenderMiddlewares.v1");

export type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type ResultMiddlewareContext = {
  toolName: string;
  result: unknown;
  options: { expanded?: boolean };
  theme: RenderTheme;
};

export type ResultMiddleware = (
  context: ResultMiddlewareContext,
  next: () => unknown,
) => unknown;

export type MiddlewareRegistration = {
  id: string;
  toolName: string;
  middleware: ResultMiddleware;
};

export type ToolDisplayApi = {
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

function removeQueuedRegistration(id: string): void {
  const queue = (globalThis as GlobalProtocol)[PENDING_MIDDLEWARES_KEY];
  if (!Array.isArray(queue)) return;
  const index = queue.findIndex((entry) => entry?.id === id);
  if (index >= 0) queue.splice(index, 1);
}

export function registerResultRenderMiddleware(
  registration: MiddlewareRegistration,
): () => void {
  const api = getApi();
  if (typeof api?.registerResultRenderMiddleware === "function") {
    api.registerResultRenderMiddleware(registration);
  } else {
    queueRegistration(registration);
  }

  return () => {
    getApi()?.unregisterResultRenderMiddleware?.(registration.id);
    removeQueuedRegistration(registration.id);
  };
}

export function isResultRenderMiddlewareActive(id: string, toolName: string): boolean {
  const api = getApi();
  return api?.hasResultRenderMiddleware?.(id) === true
    && api.isResultRenderPipelineActive?.(toolName) === true;
}

export function asComponent(value: unknown): Component | undefined {
  return value && typeof value === "object" && typeof (value as Component).render === "function"
    ? value as Component
    : undefined;
}

export function appendResultRenderPanel(baseValue: unknown, panel: Component): Component {
  const base = asComponent(baseValue);
  if (!base) return panel;
  const container = new Container();
  container.addChild(base);
  container.addChild(panel);
  return container;
}
