import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import {
  PENDING_MIDDLEWARES_KEY,
  TOOL_DISPLAY_API_KEY,
  appendResultRenderPanel,
  isResultRenderMiddlewareActive,
  registerResultRenderMiddleware,
  type MiddlewareRegistration,
} from "../src/index.ts";

function registration(id = "test.result-renderer.v1"): MiddlewareRegistration {
  return {
    id,
    toolName: "*",
    middleware: (_context, next) => next(),
  };
}

test("registers middleware through the shared tool-display protocol", () => {
  let registered: MiddlewareRegistration | undefined;
  const apiKey = TOOL_DISPLAY_API_KEY;
  const previousApi = (globalThis as any)[apiKey];
  (globalThis as any)[apiKey] = {
    registerResultRenderMiddleware: (value: MiddlewareRegistration) => {
      registered = value;
      return value.id;
    },
    unregisterResultRenderMiddleware: (id: string) => id === "test.result-renderer.v1",
    hasResultRenderMiddleware: (id: string) => id === "test.result-renderer.v1",
    isResultRenderPipelineActive: (toolName: string) => toolName === "bash",
  };

  try {
    const dispose = registerResultRenderMiddleware(registration());
    assert.equal(registered?.id, "test.result-renderer.v1");
    assert.equal(isResultRenderMiddlewareActive("test.result-renderer.v1", "bash"), true);
    assert.equal(isResultRenderMiddlewareActive("test.result-renderer.v1", "read"), false);
    dispose();
  } finally {
    if (previousApi === undefined) delete (globalThis as any)[apiKey];
    else (globalThis as any)[apiKey] = previousApi;
  }
});

test("queues middleware until the host display API is available", () => {
  const apiKey = TOOL_DISPLAY_API_KEY;
  const pendingKey = PENDING_MIDDLEWARES_KEY;
  const previousApi = (globalThis as any)[apiKey];
  const previousQueue = (globalThis as any)[pendingKey];
  delete (globalThis as any)[apiKey];
  delete (globalThis as any)[pendingKey];

  try {
    const dispose = registerResultRenderMiddleware(registration("queued.result-renderer.v1"));
    assert.equal((globalThis as any)[pendingKey]?.[0]?.id, "queued.result-renderer.v1");
    dispose();
    assert.deepEqual((globalThis as any)[pendingKey], []);
  } finally {
    if (previousApi === undefined) delete (globalThis as any)[apiKey];
    else (globalThis as any)[apiKey] = previousApi;
    if (previousQueue === undefined) delete (globalThis as any)[pendingKey];
    else (globalThis as any)[pendingKey] = previousQueue;
  }
});

test("keeps active middleware in the shared queue for host replacement", () => {
  const apiKey = TOOL_DISPLAY_API_KEY;
  const pendingKey = PENDING_MIDDLEWARES_KEY;
  const previousApi = (globalThis as any)[apiKey];
  const previousQueue = (globalThis as any)[pendingKey];
  (globalThis as any)[apiKey] = {
    registerResultRenderMiddleware: () => "distill.result-renderer.v1",
    unregisterResultRenderMiddleware: () => true,
  };
  delete (globalThis as any)[pendingKey];

  try {
    const dispose = registerResultRenderMiddleware(registration("distill.result-renderer.v1"));
    assert.equal((globalThis as any)[pendingKey]?.[0]?.id, "distill.result-renderer.v1");
    dispose();
    assert.deepEqual((globalThis as any)[pendingKey], []);
  } finally {
    if (previousApi === undefined) delete (globalThis as any)[apiKey];
    else (globalThis as any)[apiKey] = previousApi;
    if (previousQueue === undefined) delete (globalThis as any)[pendingKey];
    else (globalThis as any)[pendingKey] = previousQueue;
  }
});

test("appends a panel after a component without duplicating bridge code", () => {
  const rendered = appendResultRenderPanel(
    new Text("base", 0, 0),
    new Text("panel", 0, 0),
  );
  assert.deepEqual(rendered.render(80).map((line) => line.trimEnd()), ["base", "panel"]);
});
