import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { DEFAULT_TITLE_CONFIG, loadConfig, parseConfig } from "../src/config.ts";

test("自动、手动与三个目标默认开启，可独立关闭", () => {
  assert.deepEqual(parseConfig({}), { automaticNaming: true, manualNaming: true,
    targets: { session: true, workspace: true, tab: true }, title: DEFAULT_TITLE_CONFIG });
  for (const key of ["automaticNaming", "manualNaming"] as const) {
    assert.equal(parseConfig({ [key]: false })[key], false);
    assert.throws(() => parseConfig({ [key]: "false" }));
  }
  for (const target of ["session", "workspace", "tab"] as const) {
    assert.equal(parseConfig({ targets: { [target]: false } }).targets[target], false);
  }
});

test("配置读取仅允许文件不存在使用默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-config-"));
  try {
    assert.equal(loadConfig(join(dir, "missing.json")).automaticNaming, true);
    const path = join(dir, "config.json");
    writeFileSync(path, "{");
    assert.throws(() => loadConfig(path));
    assert.throws(() => loadConfig(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("标题偏好可配置，未知字段与非法值明确拒绝", () => {
  const title = { maxLength: 60, preferredLength: 40, language: "en", instructions: "Use sentence case", timeoutMs: 20000 };
  assert.deepEqual(parseConfig({ title }).title, title);
  for (const value of [null, [],
    { unknown: true }, { targets: null }, { targets: { unknown: true } }, { targets: { session: "false" } },
    { title: null }, { title: { typo: 1 } }, { title: { maxLength: 0 } },
    { title: { maxLength: 1.5 } }, { title: { preferredLength: 16 } },
    { title: { timeoutMs: -1 } }, { title: { timeoutMs: 2147483648 } },
    { title: { language: " " } }, { title: { language: 1 } },
    { title: { instructions: false } }, { title: { maxLength: Infinity } },
  ]) assert.throws(() => parseConfig(value), /field|字段/);
});
