import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piNotifications from "../src/index.ts";

interface RegisteredHandler {
  event: string;
  handler: (...args: any[]) => unknown;
}

test("registers lifecycle handlers and the public default export", () => {
  const handlers: RegisteredHandler[] = [];
  const pi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.push({ event, handler });
    },
  } as unknown as ExtensionAPI;

  piNotifications(pi);

  assert.deepEqual(
    handlers.map(({ event }) => event),
    ["session_start", "session_shutdown", "tool_call", "agent_start", "turn_end", "agent_end"],
  );
});
