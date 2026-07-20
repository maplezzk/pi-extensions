import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  getToolDisplayApi,
  registerToolResultRenderMiddleware,
  unregisterToolResultRenderMiddleware,
} from "../tool-display-api-consumer.js";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

const API_KEY = Symbol.for("pi-tool-display.api.v1");
const PENDING_KEY = Symbol.for("pi-tool-display.pendingResultRenderMiddlewares.v1");

type ComponentLike = { render(width: number): string[] };
type RegisteredTool = {
  name: string;
  renderResult?: (
    result: Record<string, unknown>,
    options: Record<string, unknown>,
    theme: { fg(color: string, text: string): string; bold(text: string): string },
  ) => ComponentLike;
};

function resetGlobalApi(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[API_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[PENDING_KEY];
}

function createApiStub(): { api: ExtensionAPI; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const api = {
    registerTool(tool: RegisteredTool): void {
      tools.push(tool);
    },
    on(): void {},
    getAllTools(): unknown[] {
      return ["read", "edit", "grep", "find", "ls", "bash", "write"].map((name) => ({
        name,
        sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
      }));
    },
  } as unknown as ExtensionAPI;
  return { api, tools };
}

function render(component: ComponentLike): string {
  return component.render(120).map((line) => line.trimEnd()).join("\n").trim();
}

test("queued result middleware decorates a built-in result after tool-display loads", () => {
  resetGlobalApi();
  const middlewareId = registerToolResultRenderMiddleware(
    "bash",
    (context, next) => {
      assert.equal(context.toolName, "bash");
      const container = new Container();
      container.addChild(next() as Component);
      container.addChild(new Text(context.theme.fg("accent", "external result card"), 0, 0));
      return container;
    },
    { id: "test-external-result-card" },
  );

  const { api, tools } = createApiStub();
  registerToolDisplayOverrides(api, () => ({
    ...DEFAULT_TOOL_DISPLAY_CONFIG,
    bashOutputMode: "summary",
  }));

  const bash = tools.find((tool) => tool.name === "bash");
  assert.ok(bash?.renderResult);
  const output = render(bash.renderResult(
    { content: [{ type: "text", text: "tool output" }], details: {} },
    { expanded: false, isPartial: false },
    { fg: (_color, text) => text, bold: (text) => text },
  ));
  assert.match(output, /1 line returned/);
  assert.match(output, /external result card/);
  assert.equal(getToolDisplayApi()?.hasResultRenderMiddleware(middlewareId), true);
  assert.equal(unregisterToolResultRenderMiddleware(middlewareId), true);
  resetGlobalApi();
});

test("stable middleware ids replace queued registrations and active middleware can replace base output", () => {
  resetGlobalApi();
  registerToolResultRenderMiddleware("bash", () => new Text("stale", 0, 0), { id: "stable-id" });
  registerToolResultRenderMiddleware("bash", () => new Text("latest", 0, 0), { id: "stable-id" });

  const { api, tools } = createApiStub();
  registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
  const bash = tools.find((tool) => tool.name === "bash");
  assert.ok(bash?.renderResult);
  const output = render(bash.renderResult(
    { content: [{ type: "text", text: "tool output" }], details: {} },
    { expanded: false, isPartial: false },
    { fg: (_color, text) => text, bold: (text) => text },
  ));
  assert.equal(output, "latest");
  assert.equal(unregisterToolResultRenderMiddleware("stable-id"), true);
  resetGlobalApi();
});
