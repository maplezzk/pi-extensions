import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { registerSafetyGuards } from "../index.ts";
import { parseConfig } from "../src/config.ts";
import { i18n } from "../src/i18n.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

/** 最小事件宿主；不提供 shell 执行接口，防止自动执行替代工具。 */
function host(
  hasUI = true,
  accepted = true,
  sessionEntries: readonly unknown[] = [],
  branch: readonly unknown[] = [],
) {
  const handlers = new Map<string, Handler>();
  const prompts: string[] = [];
  const notices: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    // 配置命令仅需在真实宿主中注册，安全规则测试使用空实现。
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: tmpdir(), hasUI,
    sessionManager: { getEntries: () => sessionEntries, getBranch: () => branch },

    ui: {
      confirm: async (_title: string, text: string) => { prompts.push(text); return accepted; },
      notify: (text: string) => notices.push(text),
    },
  } as unknown as ExtensionContext;
  return { pi, handlers, prompts, notices, ctx,
    emit: async (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx),
  };
}

/** 生成与 Pi tool_call 对应的无副作用测试事件。 */
function call(command: string, id = "call-1") {
  return { toolName: "bash", toolCallId: id, input: { command } };
}

test("session_squash 后目录授权仍能通过统一 Bash 规则入口", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "safety-squash-"));
  const externalRoot = join(fixtureRoot, "external");
  const cwd = join(fixtureRoot, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(externalRoot, { recursive: true });
  const state = {
    type: "custom", id: "state-1", parentId: "user-1", customType: "add-dir:state",
    data: { dirs: [{ absolutePath: externalRoot }] },
  };
  const sourceLeaf = { type: "message", id: "leaf-1", parentId: "state-1", message: {} };
  const squash = {
    type: "custom_message", id: "squash-1", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "leaf-1" }, content: "handoff",
  };
  const activeBranch = [{ type: "message", id: "user-1", parentId: null, message: {} }, squash];
  const fake = host(true, true, [state, sourceLeaf, squash], activeBranch);
  fake.ctx.cwd = cwd;
  const config = parseConfig({ presets: ["workspace-boundary"] });
  await registerSafetyGuards(fake.pi, config);
  const command = `cat ${JSON.stringify(join(externalRoot, "file.txt"))}`;
  const withoutAuthorization = host();
  withoutAuthorization.ctx.cwd = cwd;
  await registerSafetyGuards(withoutAuthorization.pi, config);
  assert.equal((await withoutAuthorization.emit("tool_call", call(command)) as { block: boolean }).block, true);
  assert.equal(await fake.emit("tool_call", call(command)), undefined);
});

test("默认危险操作确认，拒绝或无 UI 时阻断，普通构建不询问", async () => {
  for (const hasUI of [true, false]) {
    const fake = host(hasUI, false);
    await registerSafetyGuards(fake.pi, parseConfig({}));
    const result = await fake.emit("tool_call", call("rm example")) as { block: boolean; reason: string };
    assert.equal(result.block, true);
    assert.match(result.reason, /filesystem.delete/);
    assert.equal(fake.prompts.length, hasUI ? 1 : 0);
    assert.equal(await fake.emit("tool_call", call("mvn test")), undefined);
  }
  const approved = host();
  await registerSafetyGuards(approved.pi, parseConfig({}));
  assert.equal(await approved.emit("tool_call", call("rm example")), undefined);
  assert.equal(approved.prompts.length, 1);
});

test("block 不弹确认，原因包含用户填写的说明与规则 ID", async () => {
  const fake = host();
  await registerSafetyGuards(fake.pi, parseConfig({ rules: [{ id: "filesystem.delete", action: "block", message: "Custom deletion rule matched." }] }));
  const result = await fake.emit("tool_call", call("rm file")) as { block: boolean; reason: string };
  assert.equal(result.block, true);
  assert.match(result.reason, /Custom deletion rule matched/);
  assert.match(result.reason, /filesystem.delete/);
  assert.equal(fake.prompts.length, 0);
});

test("warn 不阻断，按 toolCallId 附加到对应结果，无 UI 也可见", async () => {
  const fake = host(false);
  await registerSafetyGuards(fake.pi, parseConfig({ rules: [{ id: "filesystem.delete", action: "warn" }] }));
  assert.equal(await fake.emit("tool_call", call("rm file", "warned")), undefined);
  const original = [{ type: "text", text: "original output" }];
  assert.equal(await fake.emit("tool_result", { toolCallId: "another", content: original }), undefined);
  const result = await fake.emit("tool_result", { toolCallId: "warned", content: original }) as { content: { text: string }[] };
  assert.equal(result.content[0].text, "original output");
  assert.match(result.content[1].text, /filesystem.delete/);
  assert.equal(await fake.emit("tool_result", { toolCallId: "warned", content: original }), undefined);
});

test("全部禁用不注册执行 hook，启动时说明没有保护", async () => {
  const fake = host();
  await registerSafetyGuards(fake.pi, parseConfig({ presets: [] }));
  assert.equal(fake.handlers.has("tool_call"), false);
  await fake.emit("session_start");
  assert.equal(fake.notices.length, 1);
});

test("解析和规则异常返回显式阻断，不吞掉失败", async () => {
  const fake = host();
  await registerSafetyGuards(fake.pi, parseConfig({}));
  const parsed = await fake.emit("tool_call", call('echo "unterminated')) as { block: boolean };
  assert.equal(parsed.block, true);
  const moduleHost = host();
  await registerSafetyGuards(moduleHost.pi, parseConfig({ presets: [], rules: [{ id: "custom", action: "warn", match: { module: "./rule.mjs" } }] }), {
    loader: async () => ({ default: () => { throw new Error("matcher failed"); } }),
  });
  const result = await moduleHost.emit("tool_call", call("anything")) as { block: boolean; reason: string };
  assert.equal(result.block, true);
  assert.match(result.reason, /custom.*matcher failed/);
});

test("损坏配置不默默恢复默认预设，而是通知并阻断 Bash", async (t) => {
  const before = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "safety-startup-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  });
  const configDir = join(dir, "extensions", "pi-safety-guards");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), "{");
  const fake = host();
  await extension(fake.pi);
  await fake.emit("session_start");
  assert.equal(fake.notices.length, 1);
  assert.equal((await fake.emit("tool_call", call("npm test")) as { block: boolean }).block, true);
  assert.equal(await fake.emit("tool_call", { toolName: "read", input: {} }), undefined);
});

test("未填写说明时仅反馈规则 ID 和动作，不附加替代方案", async () => {
  const fake = host();
  await registerSafetyGuards(fake.pi, parseConfig({ rules: [{ id: "filesystem.delete", action: "block" }] }));
  const result = await fake.emit("tool_call", call("rm file"));
  assert.deepEqual(result, {
    block: true,
    reason: i18n.t("blocked", { details: i18n.t("ruleMatched", { id: "filesystem.delete" }) }),
  });
});
