const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");
const TOOL_DISPLAY_PENDING_RESULT_MIDDLEWARES_KEY = Symbol.for("pi-tool-display.pendingResultRenderMiddlewares.v1");
let nextResultMiddlewareId = 0;

export function getToolDisplayApi() {
  const api = globalThis[TOOL_DISPLAY_API_KEY];
  if (
    api?.version !== 1 ||
    typeof api.decorateTool !== "function"
  ) {
    return undefined;
  }

  return api;
}

export function queueToolDisplayDecoration(tool, adapter) {
  const existing = globalThis[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
  const queue = Array.isArray(existing) ? existing : [];
  queue.push({ tool, adapter });
  globalThis[TOOL_DISPLAY_PENDING_DECORATIONS_KEY] = queue;
}

export function decorateToolForDisplay(tool, adapter, options = {}) {
  const api = getToolDisplayApi();
  if (!api) {
    queueToolDisplayDecoration(tool, adapter);
    return tool;
  }

  try {
    return api.decorateTool(tool, adapter);
  } catch (error) {
    if (options.suppressDecorateErrors) {
      return tool;
    }

    throw error;
  }
}

export function decorateMcpToolForDisplay(tool) {
  return decorateToolForDisplay(tool, { kind: "mcp", overrideExistingRenderers: true });
}

export function registerToolResultRenderMiddleware(toolName, middleware, options = {}) {
  if (typeof toolName !== "string" || !toolName.trim()) {
    throw new TypeError("toolName must be a non-empty string");
  }
  if (typeof middleware !== "function") {
    throw new TypeError("middleware must be a function");
  }

  const id = options.id || `external-result-middleware-${++nextResultMiddlewareId}`;
  const api = getToolDisplayApi();
  if (typeof api?.registerResultRenderMiddleware === "function") {
    return api.registerResultRenderMiddleware({ id, toolName, middleware });
  }

  const existing = globalThis[TOOL_DISPLAY_PENDING_RESULT_MIDDLEWARES_KEY];
  const queue = Array.isArray(existing) ? existing : [];
  const registration = { id, toolName, middleware };
  const index = queue.findIndex((entry) => entry?.id === id);
  if (index >= 0) queue[index] = registration;
  else queue.push(registration);
  globalThis[TOOL_DISPLAY_PENDING_RESULT_MIDDLEWARES_KEY] = queue;
  return id;
}

export function unregisterToolResultRenderMiddleware(id) {
  const api = getToolDisplayApi();
  const removedActive = typeof api?.unregisterResultRenderMiddleware === "function"
    ? api.unregisterResultRenderMiddleware(id)
    : false;
  const queue = globalThis[TOOL_DISPLAY_PENDING_RESULT_MIDDLEWARES_KEY];
  if (!Array.isArray(queue)) return removedActive;
  const index = queue.findIndex((entry) => entry?.id === id);
  if (index < 0) return removedActive;
  queue.splice(index, 1);
  return true;
}
