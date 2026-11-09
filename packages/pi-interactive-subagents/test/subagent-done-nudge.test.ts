import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentDone, {
  shouldScheduleAgentEndNudge,
} from "../pi-extension/subagents/subagent-done.ts";

const SQUASH_COMPLETED_EVENT = "pi-session-tools:squash-completed";

type EventHandler = (event: unknown, ctx: unknown) => void;
type BusHandler = (data: unknown) => void;
type EventRegistry = {
  handlers: Map<string, EventHandler>;
  on(event: string, handler: EventHandler): void;
  events: {
    on(channel: string, handler: BusHandler): () => void;
    emit(channel: string, data: unknown): void;
  };
};
type NudgeFixture = {
  api: { events: EventRegistry["events"] };
  ctx: {
    sessionManager: { getSessionId(): string; getLeafId(): string };
    ui: { setWidget(): void };
    isIdle(): boolean;
    hasPendingMessages(): boolean;
  };
  handlers: Map<string, EventHandler>;
  registeredTools: unknown[];
  sentUserMessages: string[];
  setIdle(isIdle: boolean): void;
  setPending(hasPendingMessages: boolean): void;
};

function createEventRegistry(): EventRegistry {
  const handlers = new Map<string, EventHandler>();
  const busHandlers = new Map<string, BusHandler[]>();
  return {
    handlers,
    on(event: string, handler: EventHandler): void {
      handlers.set(event, handler);
    },
    events: {
      on(channel: string, handler: BusHandler): () => void {
        const channelHandlers = busHandlers.get(channel) ?? [];
        channelHandlers.push(handler);
        busHandlers.set(channel, channelHandlers);
        return () => undefined;
      },
      emit(channel: string, data: unknown): void {
        for (const handler of busHandlers.get(channel) ?? []) handler(data);
      },
    },
  };
}

function createNudgeFixture(): NudgeFixture {
  const registry = createEventRegistry();
  const sentUserMessages: string[] = [];
  const registeredTools: unknown[] = [];
  let isIdle = true;
  let hasPendingMessages = false;
  const ctx = {
    sessionManager: { getSessionId: () => "session-1", getLeafId: () => "squash-1" },
    ui: { setWidget() {} },
    isIdle: () => isIdle,
    hasPendingMessages: () => hasPendingMessages,
  };
  const api = {
    ...registry,
    registerTool(tool: unknown): void { registeredTools.push(tool); },
    registerShortcut(): void {},
    getAllTools(): unknown[] { return []; },
    sendUserMessage(message: string): void { sentUserMessages.push(message); },
  };
  registerSubagentDone(api as unknown as ExtensionAPI);
  registry.handlers.get("session_start")?.({}, ctx);
  return {
    api,
    ctx,
    handlers: registry.handlers,
    registeredTools,
    sentUserMessages,
    setIdle(value: boolean): void { isIdle = value; },
    setPending(value: boolean): void { hasPendingMessages = value; },
  };
}

function applyEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;
  try {
    applyEnv(values);
    run();
  } finally {
    applyEnv(saved);
  }
}

function emitSquashCompleted(
  fixture: NudgeFixture,
  overrides: Record<string, unknown> = {},
): void {
  fixture.api.events.emit(SQUASH_COMPLETED_EVENT, {
    sessionId: "session-1",
    leafId: "squash-1",
    continuation: "next-user",
    ...overrides,
  });
}

test("completion nudge runs after the agent stops normally", () => {
  assert.equal(
    shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "stop" }]),
    true,
  );
});

test("completion nudge ignores provider errors", () => {
  assert.equal(
    shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "error" }]),
    false,
  );
});

test("completion nudge ignores user aborts", () => {
  assert.equal(
    shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "aborted" }]),
    false,
  );
});

test("completion nudge ignores output-limit stops", () => {
  assert.equal(
    shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "length" }]),
    false,
  );
});

test("successful next-user squash emits one autonomous completion nudge", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withEnv({ PI_SUBAGENT_INTERACTIVE: "0", PI_SUBAGENT_NUDGE_DELAY_MS: "1000" }, () => {
    const fixture = createNudgeFixture();
    emitSquashCompleted(fixture);
    emitSquashCompleted(fixture);
    t.mock.timers.tick(1000);
    assert.equal(fixture.sentUserMessages.length, 1);
    assert.match(fixture.sentUserMessages[0] ?? "", /subagent_done/);
  });
});

test("squash completion nudge keeps mode and activity safety boundaries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  withEnv({ PI_SUBAGENT_INTERACTIVE: "1", PI_SUBAGENT_NUDGE_DELAY_MS: "1000" }, () => {
    const interactive = createNudgeFixture();
    emitSquashCompleted(interactive);
    t.mock.timers.tick(1000);
    assert.equal(interactive.sentUserMessages.length, 0);
  });

  withEnv({ PI_SUBAGENT_INTERACTIVE: "0", PI_SUBAGENT_NUDGE_DELAY_MS: "1000" }, () => {
    const fixture = createNudgeFixture();
    emitSquashCompleted(fixture, { continuation: "auto" });
    fixture.handlers.get("input")?.({ source: "extension" }, fixture.ctx);
    emitSquashCompleted(fixture);
    t.mock.timers.tick(1000);
    assert.equal(fixture.sentUserMessages.length, 0);
  });

  withEnv({ PI_SUBAGENT_INTERACTIVE: "0", PI_SUBAGENT_NUDGE_DELAY_MS: "1000" }, () => {
    const busy = createNudgeFixture();
    busy.setIdle(false);
    emitSquashCompleted(busy);
    const queued = createNudgeFixture();
    queued.setPending(true);
    emitSquashCompleted(queued);
    t.mock.timers.tick(1000);
    assert.equal(busy.sentUserMessages.length + queued.sentUserMessages.length, 0);
  });
});
