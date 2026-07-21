import assert from "node:assert/strict";
import test from "node:test";
import { formatDone, formatTick } from "../src/format-utils.ts";

// formatTick：working 期间的紧凑格式
test("formatTick 秒级显示", () => {
  assert.equal(formatTick(0), "0s");
  assert.equal(formatTick(999), "0s");
  assert.equal(formatTick(1000), "1s");
  assert.equal(formatTick(59_000), "59s");
  assert.equal(formatTick(59_999), "59s");
});

test("formatTick 分秒显示", () => {
  assert.equal(formatTick(60_000), "1m");
  assert.equal(formatTick(61_000), "1m 1s");
  assert.equal(formatTick(600_000), "10m");
  assert.equal(formatTick(605_000), "10m 5s");
});

// formatDone：结束时的精确格式（1 位小数）
test("formatDone 秒级显示", () => {
  assert.equal(formatDone(0), "0.0s");
  assert.equal(formatDone(12_345), "12.3s");
  assert.equal(formatDone(59_000), "59.0s");
});

test("formatDone 分秒显示", () => {
  assert.equal(formatDone(60_000), "1m 0.0s");
  assert.equal(formatDone(83_000), "1m 23.0s");
});
