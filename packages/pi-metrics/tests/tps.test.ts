import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeRateUsdPerM, formatDuration, formatNumber } from "../src/format-utils.ts";
import tpsExtension from "../src/tps.ts";
import type { ElapsedTracker } from "../src/turn-elapsed.ts";

/** Pi 事件的处理器签名；测试只需要按名字取出来调用。 */
type Handler = (event: unknown, ctx: unknown) => unknown;

/** 可驱动的假 Pi：记录注册的处理器、写入的 session entry 和发出去的提示。 */
function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notices: string[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on(_event: string, _handler: (payload: unknown) => unknown) {
        return () => {};
      },
      emit() {},
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ customType, data });
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: {
      notify(message: string) {
        notices.push(message);
      },
      setWorkingMessage() {},
    },
  };
  return { pi, ctx, handlers, entries, notices };
}

/** 触发某个事件的所有处理器。 */
function emit(handlers: Map<string, Handler[]>, event: string, payload: unknown, ctx: unknown): void {
  for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
}

/** 造一条 assistant 消息；usage 字段够度量聚合用即可。 */
function assistantMessage(output: number) {
  return {
    role: "assistant",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 100,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100 + output,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
  };
}

/**
 * 假运行时钟：固定回一段运行数据，并记下是否被结算复位。
 * 测试只关心 tps 有没有拿它取数、有没有复位，不需要真实计时行为。
 */
function createFakeTracker(elapsedMs: number): { tracker: ElapsedTracker; wasReset: () => boolean } {
  let reset = false;
  const tracker: ElapsedTracker = {
    startRun() {},
    runElapsed() { return elapsedMs; },
    startTurn() {},
    endTurn() {},
    currentRun() { return { elapsedMs, turns: 2 }; },
    resetRun() { reset = true; },
    clearTurn() {},
  };
  return { tracker, wasReset: () => reset };
}

/** 跑完一轮完整的助手回合：开始、两条 assistant 消息、结束。 */
function completeTurn(handlers: Map<string, Handler[]>, ctx: unknown, turnIndex: number): void {
  emit(handlers, "turn_start", { type: "turn_start", turnIndex, timestamp: Date.now() }, ctx);
  for (let index = 0; index < 2; index++) {
    const message = assistantMessage(6);
    emit(handlers, "message_start", { type: "message_start", message }, ctx);
    emit(handlers, "message_update", { type: "message_update", message }, ctx);
    emit(handlers, "message_update", { type: "message_update", message }, ctx);
    emit(handlers, "message_end", { type: "message_end", message }, ctx);
  }
  emit(handlers, "turn_end", { type: "turn_end", turnIndex }, ctx);
}

test("TPS formatting keeps the pi-tps output conventions", () => {
  assert.equal(formatNumber(567), "567");
  assert.equal(formatNumber(1_234), "1.2K");
  assert.equal(formatNumber(2_000_000), "2M");
  assert.equal(formatDuration(2.3), "2.3s");
  assert.equal(formatDuration(60), "1m 0s");
  assert.equal(formatDuration(30 * 24 * 60 * 60), "1mo 0d");
});

test("TPS rate rejects unusable costs and zero-token turns", () => {
  assert.equal(computeRateUsdPerM(null, 100), null);
  assert.equal(computeRateUsdPerM(-1, 100), null);
  assert.equal(computeRateUsdPerM(1, 0), null);
  assert.equal(computeRateUsdPerM(1.25, 500_000), 2.5);
});

test("live 模式每轮结束就发一行，并把该轮写进 session entry", () => {
  const { pi, ctx, handlers, entries, notices } = createFakePi();
  tpsExtension(pi, { display: "live" });
  completeTurn(handlers, ctx, 0);

  assert.equal(notices.length, 1);
  // 两条 assistant 消息都计入：in 200 / out 12。
  assert.match(notices[0], /in 200/);
  assert.match(notices[0], /out 12/);
  assert.equal(entries.filter((entry) => entry.customType === "tps").length, 1);
});

test("on-stop 模式每轮都不发提示，只在整段停下后发一行汇总并结算运行时钟", () => {
  const { pi, ctx, handlers, notices } = createFakePi();
  const { tracker, wasReset } = createFakeTracker(12_000);
  tpsExtension(pi, { display: "on-stop", tracker });
  completeTurn(handlers, ctx, 0);
  completeTurn(handlers, ctx, 1);

  // 两轮都跑完也先憋住：对话区不被每轮指标刷屏，运行时钟也还没结算。
  assert.deepEqual(notices, []);
  assert.equal(wasReset(), false);
  emit(handlers, "agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(notices.length, 1);
  assert.match(notices[0], /in 400/);
  assert.match(notices[0], /out 24/);
  // 汇总行带上升 spinner 一直在显示的那段总耗时。
  assert.match(notices[0], /12\.0s/);
  assert.equal(wasReset(), true);
});

test("on-stop 模式在汇总后清空累加器，下一段运行不会带上上一段的数据", () => {
  const { pi, ctx, handlers, notices } = createFakePi();
  tpsExtension(pi, { display: "on-stop", tracker: createFakeTracker(1_000).tracker });
  completeTurn(handlers, ctx, 0);
  emit(handlers, "agent_settled", { type: "agent_settled" }, ctx);
  completeTurn(handlers, ctx, 1);
  emit(handlers, "agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(notices.length, 2);
  assert.match(notices[1], /in 200/);
  assert.match(notices[1], /out 12/);
});

test("TPS unsubscribes shared event listeners during extension shutdown", () => {
  const handlers = new Map<string, Handler[]>();
  const energyListeners = new Set<(payload: unknown) => unknown>();
  let unsubscribeCount = 0;
  let appendedEntries = 0;
  const registeredCommands: string[] = [];

  const fakePi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on(_event: string, handler: (payload: unknown) => unknown) {
        energyListeners.add(handler);
        return () => {
          unsubscribeCount++;
          energyListeners.delete(handler);
        };
      },
      emit() {},
    },
    appendEntry() {
      appendedEntries++;
    },
    registerCommand(name: string) { registeredCommands.push(name); },
  } as unknown as ExtensionAPI;

  tpsExtension(fakePi);
  assert.deepEqual(registeredCommands, []);
  assert.equal(energyListeners.size, 1);

  emit(handlers, "session_shutdown", { type: "session_shutdown" }, { hasUI: false });
  emit(handlers, "session_shutdown", { type: "session_shutdown" }, { hasUI: false });

  assert.equal(unsubscribeCount, 1);
  assert.equal(energyListeners.size, 0);
  for (const listener of energyListeners) listener({ turnIndex: 0, costUsd: 1 });
  assert.equal(appendedEntries, 0);
});
