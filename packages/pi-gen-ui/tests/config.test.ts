import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";

test("normalizeConfig falls back to defaults for missing or invalid input", () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig("nope"), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig([]), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ enabled: "yes", maxResultLines: "60", interactiveView: "sometimes" }), {
    ...DEFAULT_CONFIG,
  });
});

test("normalizeConfig clamps numeric fields and accepts valid overrides", () => {
  const normalized = normalizeConfig({
    enabled: false,
    maxResultLines: 100000,
    interactiveView: "never",
    composition: { enabled: false, model: "  typesafe-ai/jev  ", timeoutMs: 10 },
  });
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.maxResultLines, 500);
  assert.equal(normalized.interactiveView, "never");
  assert.deepEqual(normalized.composition, { enabled: false, model: "typesafe-ai/jev", timeoutMs: 500 });

  assert.equal(normalizeConfig({ maxResultLines: 0 }).maxResultLines, 5);
});

test("normalizeConfig keeps composition defaults when only some fields are set", () => {
  assert.deepEqual(normalizeConfig({ composition: { model: "custom/model" } }).composition, {
    enabled: DEFAULT_CONFIG.composition.enabled,
    model: "custom/model",
    timeoutMs: DEFAULT_CONFIG.composition.timeoutMs,
  });
  assert.deepEqual(normalizeConfig({ composition: { model: "   " } }).composition, DEFAULT_CONFIG.composition);
});

test("the shipped example configuration matches the defaults", () => {
  const example = JSON.parse(readFileSync(new URL("../config.example.json", import.meta.url), "utf8"));
  assert.deepEqual(normalizeConfig(example), DEFAULT_CONFIG);
});
