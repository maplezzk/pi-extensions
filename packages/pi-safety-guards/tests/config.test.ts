import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { loadConfig, parseConfig } from "../src/config.ts";

test("默认只有危险操作确认，不包含技术栈或目录限制", () => {
  const rules = parseConfig({}).rules;
  assert.equal(rules.length, 4);
  assert.ok(rules.every((rule) => rule.action === "confirm"));
  assert.ok(rules.every((rule) => !("outsideRoots" in rule.match)));
  assert.deepEqual(parseConfig({ presets: [] }).rules, []);
});

test("按 ID 覆盖动作、文案和匹配器，或禁用预设规则", () => {
  const config = parseConfig({
    presets: ["destructive-operations", "workspace-boundary"],
    rules: [
      { id: "filesystem.delete", action: "warn", message: "Custom deletion rule matched." },
      { id: "filesystem.format", enabled: false },
      { id: "paths.workspace", match: { outsideRoots: [".", "../shared"] } },
      { id: "custom.command", match: { commands: ["my-build"] }, action: "block" },
    ],
  });
  assert.equal(config.rules.find((rule) => rule.id === "filesystem.delete")?.action, "warn");
  assert.equal(config.rules.some((rule) => rule.id === "filesystem.format"), false);
  assert.deepEqual(config.rules.find((rule) => rule.id === "paths.workspace")?.match, { outsideRoots: [".", "../shared"] });
  assert.equal(config.rules.find((rule) => rule.id === "custom.command")?.action, "block");
});

test("规则解析不能污染下一次加载的内置预设", () => {
  const first = parseConfig({}).rules[0];
  if ("commands" in first.match) (first.match.commands as string[]).push("unexpected");
  const second = parseConfig({}).rules[0];
  if ("commands" in second.match) assert.equal(second.match.commands.includes("unexpected"), false);
});

test("拒绝拼写错误、旧技术专属配置、重复 ID 和无效规则", () => {
  const invalid = [
    null, [], { maven: false }, { javaSkill: "idea" }, { presets: ["unknown"] },
    { presets: ["__proto__"] }, { rules: null }, { rules: {} },
    { rules: [{ id: "new", action: "block" }] },
    { rules: [{ id: "new", match: { commands: ["tool"] } }] },
    { rules: [{ id: "new", action: "allow", match: { commands: ["tool"] } }] },
    { rules: [{ id: "filesystem.delete", enabled: "false" }] },
    { rules: [{ id: "filesystem.delete" }, { id: "filesystem.delete" }] },
    { rules: [{ id: "filesystem.delete", match: { commands: [] } }] },
    { rules: [{ id: "filesystem.delete", match: { commands: ["rm"], detector: "fork-bomb" } }] },
    { rules: [{ id: "filesystem.delete", match: { detector: "unknown" } }] },
    { rules: [{ id: "filesystem.delete", message: { "en-US": "only one locale" } }] },
  ];
  for (const value of invalid) assert.throws(() => parseConfig(value), JSON.stringify(value));
});

test("缺文件使用默认预设，坏文件和读取错误不静默降级", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-config-"));
  assert.equal(loadConfig(join(dir, "missing.json")).rules.length, 4);
  const path = join(dir, "config.json");
  writeFileSync(path, "{");
  assert.throws(() => loadConfig(path));
  assert.throws(() => loadConfig(dir));
});

test("公开示例可解析，自定义规则不会改变默认预设", () => {
  for (const file of ["../config.example.json", "../examples/custom-rules.json"]) {
    assert.ok(parseConfig(JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"))).rules.length);
  }
  assert.equal(parseConfig({}).rules.length, 4);
});
