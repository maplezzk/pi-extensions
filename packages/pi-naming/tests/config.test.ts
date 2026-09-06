import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TITLE_CONFIG, loadConfig, parseConfig } from "../src/config.ts";
import { registerAutomaticSessionNaming } from "../src/session-name.ts";
import { registerNaming } from "../src/index.ts";

test("三项命名能力默认开启，均可单独关闭", () => {
  assert.deepEqual(parseConfig({}), { automaticNaming: true, workspaceRename: true, tabRename: true, syncSessionName: true, title: DEFAULT_TITLE_CONFIG });
  for (const key of ["automaticNaming", "workspaceRename", "tabRename"] as const) {
    assert.equal(parseConfig({ [key]: false })[key], false);
    assert.throws(() => parseConfig({ [key]: "false" }));
  }
  for (const value of [null, []]) assert.throws(() => parseConfig(value));
});

test("禁用自动命名不注册任何 hook，不发起模型请求", () => {
  const pi = { on: () => assert.fail("disabled naming registered a hook") } as unknown as ExtensionAPI;
  registerAutomaticSessionNaming(pi, async () => assert.fail("unexpected request"), false);
});

test("配置读取只允许文件不存在使用默认值", () => {
  const dir = mkdtempSync(join(tmpdir(), "naming-config-"));
  assert.equal(loadConfig(join(dir, "missing.json")).automaticNaming, true);
  const path = join(dir, "config.json");
  writeFileSync(path, "{");
  assert.throws(() => loadConfig(path));
  assert.throws(() => loadConfig(dir));
});

test("只启用会话自动命名，不注册任何终端命令", async () => {
  const events: string[] = [];
  const pi = {
    on: (event: string) => events.push(event),
    registerCommand: () => assert.fail("automatic naming must not register terminal commands"),
  } as unknown as ExtensionAPI;
  await registerNaming(pi, parseConfig({ workspaceRename: false, tabRename: false }));
  assert.ok(events.includes("input"));
});

test("手动 workspace 和 tab 可分别启用，不注册自动输入监听", async () => {
  for (const [workspaceRename, tabRename, expected] of [
    [true, false, "rename:workspace"],
    [false, true, "rename:tab"],
  ] as const) {
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      on: (event: string) => events.push(event),
      registerCommand: (name: string) => commands.push(name),
    } as unknown as ExtensionAPI;
    await registerNaming(pi, parseConfig({ automaticNaming: false, workspaceRename, tabRename }));
    assert.deepEqual(commands, [expected]);
    assert.equal(events.includes("input"), false);
  }
});

test("全部关闭时不注册命令或事件", async () => {
  const pi = {
    on: () => assert.fail("unexpected hook"),
    registerCommand: () => assert.fail("unexpected command"),
  } as unknown as ExtensionAPI;
  await registerNaming(pi, parseConfig({ automaticNaming: false, workspaceRename: false, tabRename: false }));
});


test("标题偏好与同步开关可配置，未知字段与非法值明确拒绝", () => {
  const title = { maxLength: 60, preferredLength: 40, language: "en", instructions: "Use sentence case", timeoutMs: 20000 };
  assert.deepEqual(parseConfig({ syncSessionName: false, title }).title, title);
  assert.equal(parseConfig({ syncSessionName: false }).syncSessionName, false);
  for (const value of [
    { unknown: true }, { syncSessionName: "false" }, { title: null },
    { title: { typo: 1 } }, { title: { maxLength: 0 } },
    { title: { maxLength: 1.5 } }, { title: { preferredLength: 16 } },
    { title: { timeoutMs: -1 } }, { title: { timeoutMs: 2147483648 } },
    { title: { language: " " } }, { title: { language: 1 } },
    { title: { instructions: false } }, { title: { maxLength: Infinity } },
  ]) assert.throws(() => parseConfig(value), /field|字段/);
});
