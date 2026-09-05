import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, parseConfig } from "../src/config.ts";
import { registerSafetyGuards } from "../index.ts";

/** 记录 hook 数量，证明被关闭的功能不会注册。 */
function registeredHooks(config: ReturnType<typeof parseConfig>): string[] {
  const events: string[] = [];
  const pi = { on: (event: string) => events.push(event) } as unknown as ExtensionAPI;
  registerSafetyGuards(pi, config);
  return events;
}

test("默认启用三组守卫，分别关闭后仅注册剩余功能", () => {
  assert.equal(registeredHooks(parseConfig({})).length, 3);
  for (const key of ["dangerCommands", "bashDirectoryScope", "maven"]) {
    assert.equal(registeredHooks(parseConfig({ [key]: false })).length, 2);
  }
  assert.deepEqual(registeredHooks(parseConfig({ dangerCommands: false, bashDirectoryScope: false, maven: false })), []);
});

test("skill 配置优先于环境变量，错误开关不能被当成 false", () => {
  assert.equal(parseConfig({ javaSkill: "custom-build" }, "env-build").javaSkill, "custom-build");
  assert.equal(parseConfig({}, "env-build").javaSkill, "env-build");
  for (const value of [null, [], { maven: "false" }, { dangerCommands: 0 }, { javaSkill: "" }]) {
    assert.throws(() => parseConfig(value));
  }
});

test("文件不存在采用默认值，损坏 JSON 和读取错误显式抛出", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-config-"));
  assert.equal(loadConfig(join(dir, "missing.json")).maven, true);
  const path = join(dir, "config.json");
  writeFileSync(path, "{");
  assert.throws(() => loadConfig(path));
  assert.throws(() => loadConfig(dir));
});
