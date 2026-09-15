import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "../src/duration.ts";

test("秒级耗时只显示秒", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(999), "0s");
	assert.equal(formatDuration(26_000), "26s");
	assert.equal(formatDuration(59_999), "59s");
});

test("分钟级耗时显示分与秒", () => {
	assert.equal(formatDuration(60_000), "1m 0s");
	assert.equal(formatDuration(266_000), "4m 26s");
	assert.equal(formatDuration(3_599_000), "59m 59s");
});

test("超过一小时显示时与分", () => {
	assert.equal(formatDuration(3_600_000), "1h 0m");
	assert.equal(formatDuration(3_900_000), "1h 5m");
});

test("负值按 0 处理", () => {
	assert.equal(formatDuration(-5), "0s");
});
