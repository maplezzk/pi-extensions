import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installNoticeRenderer, resetNoticeRenderer } from "pi-extensions-i18n";
import contextFoldExtension from "../../pi-session-tools/src/session-tail-compaction.ts";
import { SESSION_SQUASH_TYPE } from "../../pi-session-tools/src/session-tail-compaction-utils.ts";
import registerSubagentDone from "../pi-extension/subagents/subagent-done.ts";

const SQUASH_COMPLETED_EVENT = "pi-session-tools:squash-completed";
const SQUASH_COMPLETION_NUDGES = new Set([
  "【压缩完成提醒】\n• 任务状态已保存，且当前正在等待上级输入。\n• 若已完成 → 调用 subagent_done 上报结果。\n• 需要主 agent 协助 → 调用 caller_ping；仍在处理 → 忽略。",
  "[Compaction completion reminder]\n• Your task state has been saved and the session is waiting for the parent.\n• If done → call subagent_done to report your result.\n• Need help from the main agent → call caller_ping; still working → ignore.",
]);

type ExtensionHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

function assertExpectedNudge(message: string | undefined, expected: ReadonlySet<string>): void {
  assert.ok(expected.has(message ?? ""));
}
type BusHandler = (data: unknown) => void;
type RegisteredTool = {
  name: string;
  execute?: (
    toolCallId: string,
    params: { from: number; summary: string; continuation: "auto" | "next-user" },
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ terminate?: boolean; isError?: boolean }>;
};
type SessionEntry = {
  type: "message" | "custom_message";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType?: string;
  content?: string;
  details?: Record<string, unknown>;
  display?: boolean;
  message?: { role: string; content: string; timestamp: number };
};
type HarnessOptions = {
  consumerFirst?: boolean;
  interactive?: "0" | "1" | undefined;
  failBranch?: boolean;
  appendSnapshot?: boolean;
  isIdle?: boolean;
  hasPendingMessages?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

type Harness = {
  context: {
    sessionManager: {
      getBranch(): SessionEntry[];
      getSessionId(): string;
      getLeafId(): string;
      branch(entryId: string): void;
    };
    getContextUsage(): { tokens: number };
    isIdle(): boolean;
    hasPendingMessages(): boolean;
    mode: "tui";
    ui: { notify(message: string): void; setWidget(): void };
  };
  tools: RegisteredTool[];
  run(event: string, payload?: unknown): Promise<void>;
  sentUserMessages: string[];
  setIdle(value: boolean): void;
  setPending(value: boolean): void;
};

async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => T | Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createHarness(options: HarnessOptions = {}): Harness {
  const handlers = new Map<string, ExtensionHandler[]>();
  const busHandlers = new Map<string, BusHandler[]>();
  const tools: RegisteredTool[] = [];
  const sentUserMessages: string[] = [];
  const initialBranch: SessionEntry[] = [
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "完成任务", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: "处理中", timestamp: 2 },
    },
  ];
  let branch = [...initialBranch];
  let isIdle = options.isIdle ?? true;
  let hasPendingMessages = options.hasPendingMessages ?? false;
  let snapshotNumber = 0;

  const context = {
    sessionManager: {
      getBranch(): SessionEntry[] {
        return branch;
      },
      getSessionId(): string {
        return "session-1";
      },
      getLeafId(): string {
        return branch[branch.length - 1]?.id ?? "";
      },
      branch(entryId: string): void {
        if (options.failBranch) throw new Error("branch failed");
        const start = branch.findIndex((entry) => entry.id === entryId);
        branch = start >= 0 ? branch.slice(0, start + 1) : [];
      },
    },
    getContextUsage(): { tokens: number } {
      return { tokens: 10 };
    },
    isIdle(): boolean {
      return isIdle;
    },
    hasPendingMessages(): boolean {
      return hasPendingMessages;
    },
    mode: "tui" as const,
    ui: {
      notify(_message: string): void {},
      setWidget(): void {},
    },
  };

  const api = {
    on(event: string, handler: ExtensionHandler): void {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
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
    registerTool(tool: RegisteredTool): void {
      tools.push(tool);
    },
    registerCommand(): void {},
    registerShortcut(): void {},
    registerMessageRenderer(): void {},
    getActiveTools(): string[] {
      return ["read", "session_log", "session_squash"];
    },
    setActiveTools(): void {},
    getAllTools(): Array<{ name: string }> {
      return [];
    },
    sendMessage(message: { customType?: string; content?: string; details?: Record<string, unknown> }, sendOptions?: { triggerTurn?: boolean }): void {
      if (
        options.appendSnapshot !== false
        && message.customType === SESSION_SQUASH_TYPE
        && sendOptions?.triggerTurn === false
      ) {
        snapshotNumber += 1;
        branch.push({
          type: "custom_message",
          id: `squash-${snapshotNumber}`,
          parentId: "user-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          customType: SESSION_SQUASH_TYPE,
          content: message.content,
          details: message.details,
          display: true,
        });
      }
    },
    sendUserMessage(message: string): void {
      sentUserMessages.push(message);
    },
    appendEntry(customType: string, data: unknown): void {
      snapshotNumber += 1;
      branch.push({
        type: "custom_message",
        id: `notice-${snapshotNumber}`,
        parentId: branch[branch.length - 1]?.id ?? null,
        timestamp: "2026-01-01T00:00:03.000Z",
        customType,
        content: "",
        details: asRecord(data),
        display: true,
      });
    },
    registerEntryRenderer(): void {},
  };

  const extensionApi = api as unknown as ExtensionAPI;
  resetNoticeRenderer();
  installNoticeRenderer(api);
  const loadExtensions = (): void => {
    contextFoldExtension(extensionApi);
    registerSubagentDone(extensionApi);
  };
  const loadConsumerFirst = (): void => {
    registerSubagentDone(extensionApi);
    contextFoldExtension(extensionApi);
  };
  (options.consumerFirst ? loadConsumerFirst : loadExtensions)();

  return {
    context,
    tools,
    sentUserMessages,
    async run(event: string, payload: unknown = {}): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler(payload, context);
    },
    setIdle(value: boolean): void {
      isIdle = value;
    },
    setPending(value: boolean): void {
      hasPendingMessages = value;
    },
  };
}

async function runSuccessfulNextUserSquash(
  harness: Harness,
  shouldStartSession = true,
): Promise<void> {
  if (shouldStartSession) await harness.run("session_start");
  const squashTool = harness.tools.find((tool) => tool.name === "session_squash");
  assert.ok(squashTool?.execute);
  const result = await squashTool.execute(
    "squash-call",
    { from: 0, summary: "完成", continuation: "next-user" },
    undefined,
    undefined,
    harness.context,
  );
  assert.equal(result.terminate, true);
  await harness.run("tool_call", { toolName: "session_squash" });
  await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse" }] });
  await harness.run("agent_settled");
}

test("session squash completion reaches autonomous subagent once through the shared event bus", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // 两种注册顺序都共享同一 pi.events 实例，不能靠手工 emit 冒充生产者。
  for (const consumerFirst of [false, true]) {
    await withEnv(
      { PI_SUBAGENT_INTERACTIVE: "0", PI_SUBAGENT_NUDGE_DELAY_MS: "1000" },
      async (): Promise<void> => {
        const harness = createHarness({ consumerFirst });
        await runSuccessfulNextUserSquash(harness);
        t.mock.timers.tick(1000);
        assert.equal(harness.sentUserMessages.length, 1);
        assertExpectedNudge(harness.sentUserMessages[0], SQUASH_COMPLETION_NUDGES);
      },
    );
  }
});

async function runInputScenario(
  source: "interactive" | "extension",
  tick: () => void,
  expectedNudges?: ReadonlySet<string>,
): Promise<void> {
  const harness = createHarness();
  await harness.run("session_start");
  await harness.run("agent_start");
  await harness.run("input", { source });
  await harness.run("agent_start");
  await runSuccessfulNextUserSquash(harness, false);
  tick();
  assert.equal(harness.sentUserMessages.length, expectedNudges ? 1 : 0);
  if (expectedNudges) assertExpectedNudge(harness.sentUserMessages[0], expectedNudges);
}

test("manual takeover persists across a new run while extension input does not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withEnv(
    { PI_SUBAGENT_INTERACTIVE: "0", PI_SUBAGENT_NUDGE_DELAY_MS: "1000" },
    () => runInputScenario("interactive", () => t.mock.timers.tick(1000)),
  );
  await withEnv(
    { PI_SUBAGENT_INTERACTIVE: "0", PI_SUBAGENT_NUDGE_DELAY_MS: "1000" },
    () => runInputScenario("extension", () => t.mock.timers.tick(1000), SQUASH_COMPLETION_NUDGES),
  );
});

test("shared squash event bus rejects unsafe producer and consumer states", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cases: Array<{ name: string; options: HarnessOptions; continuation: "auto" | "next-user" }> = [
    { name: "branch failure", options: { failBranch: true }, continuation: "next-user" },
    { name: "missing persisted snapshot", options: { appendSnapshot: false }, continuation: "next-user" },
    { name: "auto continuation", options: {}, continuation: "auto" },
    { name: "interactive child", options: { interactive: "1" }, continuation: "next-user" },
    { name: "busy child", options: { isIdle: false }, continuation: "next-user" },
    { name: "queued child", options: { hasPendingMessages: true }, continuation: "next-user" },
  ];

  for (const item of cases) {
    await withEnv(
      { PI_SUBAGENT_INTERACTIVE: item.options.interactive ?? "0", PI_SUBAGENT_NUDGE_DELAY_MS: "1000" },
      async (): Promise<void> => {
        const harness = createHarness(item.options);
        await harness.run("session_start");
        const squashTool = harness.tools.find((tool) => tool.name === "session_squash");
        assert.ok(squashTool?.execute);
        const result = await squashTool.execute(
          "squash-call",
          { from: 0, summary: "完成", continuation: item.continuation },
          undefined,
          undefined,
          harness.context,
        );
        assert.equal(result.terminate, true);
        if (item.options.failBranch) {
          await assert.rejects(() => harness.run("agent_settled"), /branch failed/);
        } else {
          await harness.run("agent_settled");
        }
        t.mock.timers.tick(1000);
        assert.equal(harness.sentUserMessages.length, 0, item.name);
      },
    );
  }
});
