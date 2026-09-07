import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadConfig, parseConfig, saveConfig } from "../src/config.ts";

test("uses enabled metrics by default and persists file configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-metrics-config-"));
  const path = join(directory, "extensions", "pi-metrics", "config.json");
  try {
    assert.deepEqual(loadConfig(path), { enabled: true });
    saveConfig(parseConfig({ enabled: false }), path);
    assert.deepEqual(loadConfig(path), { enabled: false });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects unknown and invalid fields", () => {
  assert.throws(() => parseConfig({ unknown: true }), /unknown configuration field/);
  assert.throws(() => parseConfig({ enabled: "yes" }), /enabled must be a boolean/);
});
