import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const catalog = JSON.parse(
  readFileSync(new URL("../locales/index.json", import.meta.url), "utf-8"),
);

test("locales/index.json has zh-CN and en-US for every key", () => {
  for (const [key, translations] of Object.entries(catalog)) {
    const t = translations as Record<string, string>;
    assert.ok(t["zh-CN"]?.length > 0, `key "${key}" missing zh-CN`);
    assert.ok(t["en-US"]?.length > 0, `key "${key}" missing en-US`);
  }
});

test("default export is a function", async () => {
  const mod = await import("../index.ts");
  assert.equal(typeof mod.default, "function");
});
