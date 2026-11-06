import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  getToolDisplayApi,
  registerToolResultRenderMiddleware,
  unregisterToolResultRenderMiddleware,
} from "../tool-display-api-consumer.js";
import { GENERIC_RESULT_PREVIEW_LINES } from "../src/result-middleware-coverage.ts";
import type { ResultMiddleware } from "../src/result-render-middleware.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { disposeAll, resetDisposed } from "../src/disposable.ts";

const API_KEY = Symbol.for("pi-tool-display.api.v1");
const PENDING_KEY = Symbol.for("pi-tool-display.pendingResultRenderMiddlewares.v1");
const BUILT_IN_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

type ComponentLike = { render(width: number): string[] };
type ResultRenderer = (...args: unknown[]) => unknown;

interface CustomTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  renderResult?: ResultRenderer;
}

interface ToolEventHandlers {
  session_start?: () => Promise<void> | void;
  before_agent_start?: () => Promise<void> | void;
}

/** 每个用例都从干净的共享协议开始：宿主 API 与等待队列都清掉。 */
function resetGlobalApi(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[API_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[PENDING_KEY];
  resetDisposed();
}

/** 造一个只提供本用例关心的能力的扩展 API 桩。 */
function createApiStub(customTools: CustomTool[]): {
  api: ExtensionAPI;
  handlers: ToolEventHandlers;
} {
  const handlers: ToolEventHandlers = {};
  const api = {
    registerTool(): void {},
    on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
      handlers[event] = handler;
    },
    getAllTools(): unknown[] {
      return [
        ...BUILT_IN_TOOL_NAMES.map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } })),
        ...customTools,
      ];
    },
    getActiveTools(): string[] {
      return [...BUILT_IN_TOOL_NAMES];
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

/** 在工具自己的结果块后面追加一张卡片，模拟结果渲染中间件的典型用法。 */
function appendCardMiddleware(label: string): ResultMiddleware {
  return (context, next) => {
    const container = new Container();
    const base = next();
    if (base) {
      container.addChild(base as Component);
    }
    container.addChild(new Text(`${label}:${context.toolName}`, 0, 0));
    return container;
  };
}

function renderResult(tool: CustomTool, result: unknown, expanded: boolean): string {
  const output = (tool.renderResult as ResultRenderer)(
    result,
    { expanded, isPartial: false },
    THEME,
    { args: {}, toolCallId: "call_1" },
  ) as ComponentLike;
  return output.render(120).map((line) => line.trimEnd()).join("\n").trim();
}

function textResult(lines: string[]): unknown {
  return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
}

test("通配符中间件会接到自带 renderResult 的自定义工具上，并保留它自己的输出", () => {
  resetGlobalApi();
  const tool: CustomTool = {
    name: "ffgrep",
    description: "fuzzy grep",
    parameters: { type: "object", properties: {} },
    renderResult: () => new Text("ffgrep own output", 0, 0),
  };
  const middlewareId = registerToolResultRenderMiddleware("*", appendCardMiddleware("audit card"), {
    id: "coverage-wildcard",
  });
  const { api } = createApiStub([tool]);

  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

  assert.equal(getToolDisplayApi()?.isResultRenderPipelineActive("ffgrep"), true);
  const output = renderResult(tool, textResult(["ignored by tool renderer"]), false);
  assert.match(output, /ffgrep own output/);
  assert.match(output, /audit card:ffgrep/);

  unregisterToolResultRenderMiddleware(middlewareId);
  resetGlobalApi();
});

test("没有 renderResult 的工具复刻 Pi 默认结果块，中间件面板挂在其后", () => {
  resetGlobalApi();
  const lines = Array.from({ length: 14 }, (_value, index) => `output line ${index + 1}`);
  const tool: CustomTool = {
    name: "session_log",
    description: "session log",
    parameters: { type: "object", properties: {} },
  };
  const middlewareId = registerToolResultRenderMiddleware("*", appendCardMiddleware("audit card"), {
    id: "coverage-generic-base",
  });
  const { api } = createApiStub([tool]);

  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

  assert.equal(typeof tool.renderResult, "function");
  const collapsed = renderResult(tool, textResult(lines), false);
  assert.match(collapsed, /output line 1\b/);
  assert.match(collapsed, new RegExp(`output line ${GENERIC_RESULT_PREVIEW_LINES}\\b`));
  assert.doesNotMatch(collapsed, /output line 11\b/);
  assert.match(collapsed, /\.\.\. \(4 more lines, Ctrl\+O to expand\)/);
  assert.match(collapsed, /audit card:session_log/);

  const expanded = renderResult(tool, textResult(lines), true);
  assert.match(expanded, /output line 14\b/);
  assert.doesNotMatch(expanded, /more lines/);

  unregisterToolResultRenderMiddleware(middlewareId);
  resetGlobalApi();
});

test("按名字注册的中间件只覆盖它声明的工具", () => {
  resetGlobalApi();
  const ownRenderer: ResultRenderer = () => new Text("ffgrep own output", 0, 0);
  const ffgrep: CustomTool = {
    name: "ffgrep",
    description: "fuzzy grep",
    parameters: { type: "object", properties: {} },
    renderResult: ownRenderer,
  };
  const sessionLog: CustomTool = {
    name: "session_log",
    description: "session log",
    parameters: { type: "object", properties: {} },
  };
  const middlewareId = registerToolResultRenderMiddleware("session_log", appendCardMiddleware("audit card"), {
    id: "coverage-named",
  });
  const { api } = createApiStub([ffgrep, sessionLog]);

  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

  assert.equal(getToolDisplayApi()?.isResultRenderPipelineActive("session_log"), true);
  assert.equal(getToolDisplayApi()?.isResultRenderPipelineActive("ffgrep"), false);
  assert.equal(ffgrep.renderResult, ownRenderer);
  assert.match(renderResult(sessionLog, textResult(["log body"]), false), /audit card:session_log/);

  unregisterToolResultRenderMiddleware(middlewareId);
  resetGlobalApi();
});

test("先注册中间件、后出现同名工具时也会接上线", () => {
  resetGlobalApi();
  const middlewareId = registerToolResultRenderMiddleware("session_log", appendCardMiddleware("late card"), {
    id: "coverage-late-registration",
  });
  const customTools: CustomTool[] = [];
  const { api } = createApiStub(customTools);

  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

  const lateTool: CustomTool = {
    name: "session_log",
    description: "session log",
    parameters: { type: "object", properties: {} },
  };
  customTools.push(lateTool);
  api.registerTool(lateTool as never);

  assert.equal(getToolDisplayApi()?.isResultRenderPipelineActive("session_log"), true);
  assert.match(renderResult(lateTool, textResult(["log body"]), false), /late card:session_log/);

  unregisterToolResultRenderMiddleware(middlewareId);
  resetGlobalApi();
});

test("重复扫描不会把中间件套成多层", async () => {
  resetGlobalApi();
  const tool: CustomTool = {
    name: "session_log",
    description: "session log",
    parameters: { type: "object", properties: {} },
  };
  const middlewareId = registerToolResultRenderMiddleware("*", appendCardMiddleware("audit card"), {
    id: "coverage-idempotent",
  });
  const { api, handlers } = createApiStub([tool]);

  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  await handlers.session_start?.();
  await handlers.before_agent_start?.();
  await handlers.before_agent_start?.();

  const output = renderResult(tool, textResult(["log body"]), false);
  assert.equal(output.match(/audit card:session_log/g)?.length, 1);

  unregisterToolResultRenderMiddleware(middlewareId);
  resetGlobalApi();
});

test("宿主清理后工具恢复原始渲染", () => {
  resetGlobalApi();
  const tool: CustomTool = {
    name: "session_log",
    description: "session log",
    parameters: { type: "object", properties: {} },
  };
  const middlewareId = registerToolResultRenderMiddleware("*", appendCardMiddleware("audit card"), {
    id: "coverage-dispose",
  });
  const { api } = createApiStub([tool]);

  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  assert.equal(typeof tool.renderResult, "function");

  disposeAll();

  assert.equal(tool.renderResult, undefined);
  unregisterToolResultRenderMiddleware(middlewareId);
  resetGlobalApi();
});
