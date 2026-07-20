export type RuntimeToolDefinition = Record<string, unknown>;

export interface ToolDisplayAdapter {
  kind?: "read" | "edit" | "mcp" | "generic";
  overrideExistingRenderers?: boolean;
}

export interface ToolDisplayApi {
  version: 1;
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter | Record<string, unknown>): T;
  registerResultRenderMiddleware(registration: ToolResultRenderMiddlewareRegistration): string;
  unregisterResultRenderMiddleware(id: string): boolean;
  hasResultRenderMiddleware(id: string): boolean;
  isResultRenderPipelineActive(toolName: string): boolean;
}

export interface ToolResultRenderMiddlewareContext {
  toolName: string;
  result: unknown;
  options: Record<string, unknown>;
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  };
  renderContext?: unknown;
}

export type ToolResultRenderMiddleware = (
  context: ToolResultRenderMiddlewareContext,
  next: () => unknown,
) => unknown;

export interface ToolResultRenderMiddlewareRegistration {
  id?: string;
  toolName: string;
  middleware: ToolResultRenderMiddleware;
}

export interface ToolResultRenderMiddlewareOptions {
  id?: string;
}

export interface DecorateToolForDisplayOptions {
  suppressDecorateErrors?: boolean;
}

export declare function getToolDisplayApi(): ToolDisplayApi | undefined;

export declare function queueToolDisplayDecoration<T extends RuntimeToolDefinition>(
  tool: T,
  adapter?: ToolDisplayAdapter | Record<string, unknown>,
): void;

export declare function decorateToolForDisplay<T extends object>(
  tool: T,
  adapter?: ToolDisplayAdapter | Record<string, unknown>,
  options?: DecorateToolForDisplayOptions,
): T;

export declare function decorateMcpToolForDisplay<T extends RuntimeToolDefinition>(tool: T): T;

export declare function registerToolResultRenderMiddleware(
  toolName: string,
  middleware: ToolResultRenderMiddleware,
  options?: ToolResultRenderMiddlewareOptions,
): string;

export declare function unregisterToolResultRenderMiddleware(id: string): boolean;
