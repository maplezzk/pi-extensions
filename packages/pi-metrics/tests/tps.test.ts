import assert from "node:assert/strict";
import test from "node:test";
import tpsExtension, { computeRateUsdPerM, formatDuration, formatNumber } from "../src/tps.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

test("TPS unsubscribes shared event listeners during extension shutdown", () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const energyListeners = new Set<(payload: unknown) => unknown>();
  let unsubscribeCount = 0;
  let appendedEntries = 0;

  const fakePi = {
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
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
    registerCommand() {},
  } as unknown as ExtensionAPI;

  tpsExtension(fakePi);
  assert.equal(energyListeners.size, 1);

  handlers.get("session_shutdown")?.();
  handlers.get("session_shutdown")?.();

  assert.equal(unsubscribeCount, 1);
  assert.equal(energyListeners.size, 0);
  for (const listener of energyListeners) listener({ turnIndex: 0, costUsd: 1 });
  assert.equal(appendedEntries, 0);
});
