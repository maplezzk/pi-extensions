import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PRESETS_DIRECTORY, loadPresets } from "../src/presets.ts";

const COMMAND_RULE = `[{ "id": "demo", "action": "warn", "match": { "commands": ["demo"] } }]`;

/** 在独立的临时目录里放预设文件，避免缓存串目录。 */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "safety-presets-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test("内置预设来自包内 presets 目录，文件名就是预设名", () => {
  const catalog = loadPresets();
  assert.deepEqual(Object.keys(catalog), ["destructive-operations", "workspace-boundary"]);
  assert.deepEqual(catalog["destructive-operations"]?.map((rule) => rule.id), [
    "filesystem.delete",
    "filesystem.format",
    "filesystem.ownership",
    "shell.fork-bomb",
  ]);
  assert.deepEqual(catalog["workspace-boundary"], [
    { id: "paths.workspace", action: "block", match: { outsideRoots: ["."] } },
  ]);
  assert.equal(PRESETS_DIRECTORY.endsWith("presets"), true);
});

test("预设按文件名排序，同一目录只解析一次并返回冻结结果", () => {
  const dir = fixture({
    "b-preset.json": COMMAND_RULE,
    "a-preset.json": COMMAND_RULE,
  });
  const catalog = loadPresets(dir);
  assert.deepEqual(Object.keys(catalog), ["a-preset", "b-preset"]);
  assert.equal(loadPresets(dir), catalog);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog["a-preset"]), true);
  assert.throws(() => (catalog["a-preset"] as unknown as unknown[]).push({}));
});

test("坏 JSON、空数组、缺字段、重复 ID 和非法文件名都报错，不静默降级", () => {
  const cases: Record<string, string>[] = [
    { "broken.json": "{" },
    { "empty.json": "[]" },
    { "missing-match.json": `[{ "id": "demo", "action": "warn" }]` },
    { "unknown-key.json": `[{ "id": "demo", "action": "warn", "match": { "commands": ["demo"] }, "extra": 1 }]` },
    {
      "duplicate-id.json":
        `[{ "id": "demo", "action": "warn", "match": { "commands": ["demo"] } },` +
        ` { "id": "demo", "action": "block", "match": { "commands": ["demo"] } }]`,
    },
    { "Bad Name.json": COMMAND_RULE },
  ];
  for (const files of cases) {
    const dir = fixture(files);
    const file = Object.keys(files)[0] ?? "";
    assert.throws(() => loadPresets(dir), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), file);
  }
});

test("目录缺失或没有预设文件时报错，不当作没有预设", () => {
  const empty = mkdtempSync(join(tmpdir(), "safety-presets-empty-"));
  assert.throws(() => loadPresets(empty), /safety-presets-empty/);
  assert.throws(() => loadPresets(join(empty, "missing")), /missing/);
});
