import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { buildModel } from "../src/index.ts";

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

test("discovered models expose xhigh and max thinking levels", () => {
	const model = buildModel("some-model", undefined, undefined, undefined, undefined) as unknown as Model<Api>;
	assert.deepEqual(getSupportedThinkingLevels(model), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});
