import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const catalog = JSON.parse(
  readFileSync(new URL("../locales/index.json", import.meta.url), "utf8"),
) as Record<string, Record<string, string>>;

test("catalog has non-empty zh-CN and en-US text for every key", () => {
  for (const [key, translations] of Object.entries(catalog)) {
    assert.ok(translations["zh-CN"], `${key} is missing zh-CN`);
    assert.ok(translations["en-US"], `${key} is missing en-US`);
  }
});
