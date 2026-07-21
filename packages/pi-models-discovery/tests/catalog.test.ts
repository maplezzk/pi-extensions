import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("locales catalog provides zh-CN and en-US for every key", () => {
	const catalog = JSON.parse(
		readFileSync(new URL("../locales/index.json", import.meta.url), "utf-8"),
	) as Record<string, Record<string, string>>;
	for (const [key, entry] of Object.entries(catalog)) {
		assert.ok(typeof entry["zh-CN"] === "string" && entry["zh-CN"].length > 0, `${key} missing zh-CN`);
		assert.ok(typeof entry["en-US"] === "string" && entry["en-US"].length > 0, `${key} missing en-US`);
	}
});

test("default export is an extension factory", async () => {
	const mod = await import("../index.ts");
	assert.equal(typeof mod.default, "function");
});
