import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { DEFAULT_RULES, ensureConfigFile, loadConfig, loadConfigDocument, parseConfig } from "../src/config.ts";

/** 用例里反复使用的合法规则；避免同一份 JSON 散落多份。 */
const RULE = { id: "custom", action: "block", match: { commands: ["example"] } };

test("没有 rules 字段就没有规则，代码里不内置任何默认规则", () => {
  assert.deepEqual(parseConfig({}).rules, []);
  assert.deepEqual(parseConfig({ rules: [] }).rules, []);
});

test("默认规则是首启写进配置文件的普通规则，本身可解析", () => {
  const rules = parseConfig({ rules: DEFAULT_RULES }).rules;
  assert.equal(rules.length, 4);
  assert.ok(rules.every((rule) => rule.action === "confirm"));
  assert.ok(rules.every((rule) => !("outsideRoots" in rule.match)));
});

test("enabled 只决定是否执行，关掉的规则仍必须自身合法", () => {
  const config = parseConfig({
    rules: [
      RULE,
      { id: "off", enabled: false, action: "warn", match: { commands: ["off"] } },
    ],
  });
  assert.deepEqual(config.rules.map((rule) => rule.id), ["custom"]);
  assert.throws(() => parseConfig({ rules: [{ id: "off", enabled: false }] }), /off/);
  assert.throws(() => parseConfig({ rules: [{ ...RULE, enabled: "false" }] }), /enabled/);
});

test("presets 字段已删除，直接报错并指向 rules", () => {
  assert.throws(() => parseConfig({ presets: ["destructive-operations"] }), /rules/);
});

test("拒绝拼写错误、未知字段、重复 ID 和无效规则", () => {
  const invalid = [
    null, [], { maven: false }, { javaSkill: "idea" }, { rules: null }, { rules: {} },
    { rules: [RULE, RULE] },
    { rules: [{ id: "new", action: "block" }] },
    { rules: [{ id: "new", match: { commands: ["tool"] } }] },
    { rules: [{ id: "new", action: "allow", match: { commands: ["tool"] } }] },
    { rules: [{ id: "new", action: "block", match: { commands: ["tool"] }, extra: 1 }] },
    { rules: [{ id: "new", action: "block", match: { commands: [] } }] },
    { rules: [{ id: "new", action: "block", match: { commands: ["rm"], detector: "fork-bomb" } }] },
    { rules: [{ id: "new", action: "block", match: { detector: "unknown" } }] },
    { rules: [{ id: "new", action: "block", match: { commandPrefixes: [] } }] },
    { rules: [{ id: "new", action: "block", match: { commandPattern: "[" } }] },
    { rules: [{ id: "new", action: "block", match: { commandPattern: 5 } }] },
    { rules: [{ id: "new", action: "block", match: { commands: ["rm"] }, message: { "en-US": "only one locale" } }] },
  ];
  for (const value of invalid) assert.throws(() => parseConfig(value), JSON.stringify(value));
});

test("detector 已移除，写老配置时直接给出替代写法", () => {
  assert.throws(
    () => parseConfig({ rules: [{ id: "custom", action: "block", match: { detector: "disk-format" } }] }),
    /commandPrefixes/,
  );
});

test("commandPattern 必须是写配置时就能编译的正则", () => {
  const rules = parseConfig({
    rules: [{ id: "custom", action: "block", match: { commandPattern: "^mkfs\\." } }],
  }).rules;
  assert.deepEqual(rules[0]?.match, { commandPattern: "^mkfs\\." });
});

test("公开示例可解析", () => {
  const files = ["../config.example.json", "../examples/custom-rules.json"];
  const documents = files.map((file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")));
  for (const document of documents) assert.ok(parseConfig(document).rules.length);
});

test("首启写入默认规则，已有文件一律不动", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-config-seed-"));
  const path = join(dir, "config.json");
  assert.equal(ensureConfigFile(path), true);
  assert.equal(existsSync(path), true);
  assert.equal(parseConfig(JSON.parse(readFileSync(path, "utf8"))).rules.length, 4);
  assert.equal(ensureConfigFile(path), false);
  writeFileSync(path, JSON.stringify({ rules: [] }));
  assert.equal(ensureConfigFile(path), false);
  assert.deepEqual(parseConfig(JSON.parse(readFileSync(path, "utf8"))).rules, []);
});

test("缺文件按没有规则处理，坏文件和读取错误不静默降级", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-config-read-"));
  assert.deepEqual(loadConfig(join(dir, "missing.json")).rules, []);
  assert.deepEqual(loadConfigDocument(join(dir, "missing.json")).rules, []);
  const path = join(dir, "config.json");
  writeFileSync(path, "{");
  assert.throws(() => loadConfig(path));
  assert.throws(() => loadConfig(dir));
  writeFileSync(path, JSON.stringify({
    rules: [RULE, { id: "off", enabled: false, action: "warn", match: { commands: ["off"] } }],
  }));
  assert.deepEqual(loadConfigDocument(path).rules.length, 2);
  assert.deepEqual(loadConfig(path).rules.map((rule) => rule.id), ["custom"]);
});
