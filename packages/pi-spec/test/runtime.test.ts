import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { loadState } from "../src/storage.ts";
import { createState, transition, type StateFile, type Artifact } from "../src/state.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;
/** 本扩展注册的两个自有工具，与 src/index.ts 的常量保持一致。 */
const SUBMIT_TOOL = "spec_submit";
const APPROVAL_TOOL = "spec_request_approval";
/** 生成与持久化协议一致的 sha256: 指纹。 */
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** 磁盘协议版本：与 src/state.ts 的常量同名对齐，测试里不散落字面量。 */
const SCHEMA_V1 = "pi-spec-mode/v1";
const SCHEMA_V2 = "pi-spec-mode/v2";
const SCHEMA_UNSUPPORTED = "pi-spec-mode/v9";

/** 模拟 Pi 命令与事件，在独立临时目录中运行真实扩展。 */
function harness(options: { hasUI?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-spec-runtime-"));
  let command: Command;
  const tools = new Map<string, Tool>();
  let active = ["read", "write", "edit", "bash"];
  const handlers = new Map<string, Handler>();
  const notices: Array<{ text: string; level: string }> = [];
  const branch: unknown[] = [];
  let registered = ["read", "write", "edit", "bash", SUBMIT_TOOL, APPROVAL_TOOL, "extra"];
  const pi = {
    registerCommand: (_name: string, def: Command) => { command = def; },
    registerTool: (def: Tool) => { tools.set(def.name, def); },
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getActiveTools: () => [...active],
    getAllTools: () => registered.map((name) => ({ name })),
    setActiveTools: (next: string[]) => { active = [...next]; },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, mode: "rpc", hasUI: options.hasUI ?? true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (text: string, level: string) => notices.push({ text, level }),
      confirm: async () => true,
      // 默认取消；需要交互路径的用例自行覆盖返回值
      select: async () => undefined as string | undefined,
      input: async () => undefined as string | undefined,
      setStatus: () => {}, setWidget: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;
  extension(pi);
  const dir = (slug: string) => join(cwd, ".pi", "specs", slug);
  const file = (slug: string, name: string) => join(dir(slug), name);
  /** 写入指定待批阶段的 v1 状态及文档。 */
  function fixture(slug = "demo", stage: Artifact = "requirements") {
    mkdirSync(dir(slug), { recursive: true });
    let state = createState(slug, slug, "strict");
    for (const artifact of ["requirements", "design", "tasks", "verification"] as Artifact[]) {
      writeFileSync(file(slug, `${artifact}.md`), artifact);
      if (artifact === "verification" && stage !== "verification") break;
      const submitted = transition(state, { type: "submit", sha256: hash(artifact) });
      assert.ok(submitted.ok); state = submitted.state;
      if (artifact === stage) break;
      const approved = transition(state, { type: "approve" });
      assert.ok(approved.ok); state = approved.state;
      if (artifact === "tasks") {
        const done = transition(state, { type: "all_tasks_done" });
        assert.ok(done.ok); state = done.state;
      }
    }
    writeFileSync(file(slug, "state.json"), JSON.stringify(state));
  }
  return {
    ctx, notices, fixture, file, branch,
    setTools: (next: string[]) => { active = [...next]; },
    unregister: (name: string) => { registered = registered.filter((n) => n !== name); },
    run: (args: string) => command.handler(args, ctx as Parameters<Command["handler"]>[1]),
    /** 调用注册的参数补全；实现是同步的，此处统一按可能返回 Promise 的签名取出结果。 */
    complete: async (prefix: string) => (await command.getArgumentCompletions?.(prefix)) ?? null,
    emit: (name: string, event = {}) => handlers.get(name)?.(event, ctx),
    disk: (slug = "demo") => JSON.parse(readFileSync(file(slug, "state.json"), "utf8")) as StateFile,
    tools: () => active,
    /** 调用本扩展注册的工具，返回文本与 details，便于断言。 */
    invoke: async (name: string) => {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} must be registered`);
      return tool.execute("test", {}, undefined, undefined, ctx);
    },
    /** 提交当前阶段文档；其余工具通过 invoke 调用。 */
    submit: () => {
      const tool = tools.get(SUBMIT_TOOL);
      assert.ok(tool, `${SUBMIT_TOOL} must be registered`);
      return tool.execute("test", {}, undefined, undefined, ctx);
    },
  };
}

for (const mutation of ["modify", "delete"] as const) {
  test(`确认期间${mutation}当前文档，不批准旧指纹`, async () => {
    const h = harness(); h.fixture(); await h.run("use demo");
    h.ctx.ui.confirm = async () => {
      if (mutation === "modify") writeFileSync(h.file("demo", "requirements.md"), "changed");
      else renameSync(h.file("demo", "requirements.md"), h.file("demo", "requirements.old"));
      return true;
    };
    await h.run("approve");
    assert.equal(h.disk().phase, "requirements");
    assert.equal(h.disk().status, "drafting");
    assert.equal(h.disk().artifacts.requirements.approvedSha256, undefined);
  });
}

test("确认期间切换规格，不能批准另一个规格", async () => {
  const h = harness(); h.fixture(); h.fixture("second"); await h.run("use demo");
  h.ctx.ui.confirm = async () => { await h.run("use second"); return true; };
  await h.run("approve");
  assert.equal(h.disk().status, "awaiting_approval");
  assert.equal(h.disk("second").status, "awaiting_approval");
});

test("确认期间修改上游，使其失效且拒绝批准", async () => {
  const h = harness(); h.fixture("demo", "design"); await h.run("use demo");
  h.ctx.ui.confirm = async () => { writeFileSync(h.file("demo", "requirements.md"), "changed"); return true; };
  await h.run("approve");
  assert.equal(h.disk().phase, "requirements");
  assert.equal(h.disk().status, "drafting");
});

test("确认期间磁盘 revision 变化不得覆盖", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  h.ctx.ui.confirm = async () => {
    const disk = h.disk(); disk.revision += 10;
    writeFileSync(h.file("demo", "state.json"), JSON.stringify(disk)); return true;
  };
  await h.run("approve");
  assert.equal(h.disk().revision, 12);
  assert.equal(h.disk().status, "awaiting_approval");
});

test("旧 v1 状态正常批准，verification 修改后取消完成状态", async () => {
  const h = harness(); h.fixture("demo", "verification"); await h.run("use demo");
  await h.run("approve"); assert.equal(h.disk().phase, "complete");
  writeFileSync(h.file("demo", "verification.md"), "changed");
  await h.emit("before_agent_start");
  assert.equal(h.disk().phase, "verification");
  assert.equal(h.disk().status, "drafting");
});

test("操作前发现上游修改，阻止原本允许的执行工具", async () => {
  const h = harness(); h.fixture("demo", "tasks"); await h.run("use demo"); await h.run("approve");
  writeFileSync(h.file("demo", "requirements.md"), "changed");
  const result = await h.emit("tool_call", { toolName: "bash", input: { command: "true" } });
  assert.equal((result as { block?: boolean })?.block, true);
  assert.equal(h.disk().phase, "requirements");
});


test("保存失败不展示成功、不提前放开工具，内存保持原阶段", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  const before = h.disk(); const tools = [...h.tools()];
  const rename = mock.method(fs, "renameSync", () => { throw new Error("injected write failure"); });
  syncBuiltinESMExports();
  try {
    await h.run("approve");
    assert.deepEqual(h.disk(), before);
    assert.deepEqual(h.tools(), tools);
    assert.equal(h.notices.at(-1)?.level, "error");
  } finally {
    rename.mock.restore(); syncBuiltinESMExports();
  }
  await h.run("status");
  assert.match(h.notices.at(-1)!.text, /requirements.awaiting_approval/);
});

test("确认期间状态损坏时拒绝批准并报告错误", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  h.ctx.ui.confirm = async () => { writeFileSync(h.file("demo", "state.json"), "broken"); return true; };
  await h.run("approve");
  assert.equal(h.notices.at(-1)?.level, "error");
  assert.equal(readFileSync(h.file("demo", "state.json"), "utf8"), "broken");
});

for (const [label, corrupt] of Object.entries({
  id: (s: StateFile) => { s.id = "another"; },
  schema: (s: StateFile) => { (s as { schema: string }).schema = SCHEMA_UNSUPPORTED; },
  revision: (s: StateFile) => { s.revision = -1; },
  status: (s: StateFile) => { s.status = "done"; },
  chain: (s: StateFile) => { s.phase = "implementation"; s.status = "in_progress"; },
  progress: (s: StateFile) => { Object.assign(s, { completedTasks: "TASK-1" }); },
  fingerprint: (s: StateFile) => { s.artifacts.requirements.sha256 = "fake"; },
  artifacts: (s: StateFile) => { Object.assign(s, { artifacts: null }); },
})) {
  test(`读取状态拒绝非法 ${label}`, () => {
    const h = harness(); h.fixture();
    const state = h.disk(); corrupt(state);
    writeFileSync(h.file("demo", "state.json"), JSON.stringify(state));
    assert.throws(() => loadState(h.ctx.cwd, "demo"));
  });
}

test("v1 缺少 completedTasks 可读，但不凭空补审批记录", () => {
  const h = harness(); h.fixture();
  const state = h.disk() as Partial<StateFile>; delete state.completedTasks;
  writeFileSync(h.file("demo", "state.json"), JSON.stringify(state));
  assert.deepEqual(loadState(h.ctx.cwd, "demo").completedTasks, []);
});

for (const target of ["missing", "../escape", "corrupt"]) {
  test(`恢复 ${target} 清除旧授权并阻断，stop 可恢复`, async () => {
    const h = harness(); h.fixture("demo", "tasks"); await h.run("use demo"); await h.run("approve");
    if (target === "corrupt") { h.fixture(target); writeFileSync(h.file(target, "state.json"), "{}"); }
    h.branch.splice(0, h.branch.length, { type: "custom", customType: "spec-mode", data: { activeSlug: target } });
    await h.emit("session_tree");
    assert.equal(h.notices.at(-1)?.level, "error");
    assert.equal((await h.emit("tool_call", { toolName: "bash", input: {} }) as { block?: boolean })?.block, true);
    await h.run("stop");
    assert.equal(await h.emit("tool_call", { toolName: "bash", input: {} }), undefined);
    assert.ok(!h.tools().includes(SUBMIT_TOOL));
  });
}

test("导航到无规格分支退出，保留其他扩展的工具增删", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  h.setTools([...h.tools().filter((t) => t !== "read"), "extra"]);
  h.branch.splice(0); await h.emit("session_tree");
  assert.ok(h.tools().includes("extra")); assert.ok(!h.tools().includes("read"));
  assert.ok(h.tools().includes("bash")); assert.ok(!h.tools().includes(SUBMIT_TOOL));
  await h.emit("session_tree"); assert.ok(!h.tools().includes("read"));
});

test("恢复时检查批准指纹，不等待下一次工具调用", async () => {
  const h = harness(); h.fixture("demo", "design"); await h.run("use demo");
  writeFileSync(h.file("demo", "requirements.md"), "changed");
  await h.emit("session_start"); assert.equal(h.disk().phase, "requirements");
});

test("drafting 才暴露提交工具；退出不恢复已注销工具", async () => {
  const h = harness(); await h.emit("session_start"); assert.ok(!h.tools().includes(SUBMIT_TOOL));
  h.fixture(); await h.run("use demo"); assert.ok(!h.tools().includes(SUBMIT_TOOL));
  await h.run("revise requirements"); assert.ok(h.tools().includes(SUBMIT_TOOL));
  h.unregister("bash"); await h.run("stop"); assert.ok(!h.tools().includes("bash"));
});


test("工具差量保留其他扩展对 write 的移除", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  h.setTools(h.tools().filter((tool) => tool !== "write"));
  await h.run("revise requirements"); assert.ok(!h.tools().includes("write"));
  await h.run("stop"); assert.ok(!h.tools().includes("write"));
});

test("同名工具已被 spec 隐藏时无法观察其他扩展的再次禁用", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  h.setTools(h.tools().filter((tool) => tool !== "bash"));
  await h.run("stop");
  // Pi 仅提供最终工具集合，没有禁用操作的归属记录；该歧义不能伪装成可判定。
  assert.ok(h.tools().includes("bash"));
});

test("损坏恢复后可 use 有效规格，重复恢复不放开等待阶段提交工具", async () => {
  const h = harness(); h.fixture();
  h.branch.push({ type: "custom", customType: "spec-mode", data: { activeSlug: "missing" } });
  await h.emit("session_start"); await h.run("use demo");
  await h.emit("session_start"); await h.emit("session_tree");
  assert.ok(!h.tools().includes(SUBMIT_TOOL));
  await h.run("approve"); assert.equal(h.disk().phase, "design");
});


/** 建立真实批准的执行状态与两个任务定义，便于验证新旧 DONE 的归属。 */
async function executionFixture() {
  const h = harness(); h.fixture("demo", "tasks");
  const md = "## TASK-1\n## TASK-2\n";
  writeFileSync(h.file("demo", "tasks.md"), md);
  const s = h.disk(); s.artifacts.tasks.sha256 = hash(md);
  writeFileSync(h.file("demo", "state.json"), JSON.stringify(s));
  await h.run("use demo"); await h.run("approve");
  return h;
}

/** 当前轮次产生 assistant 的新完成标记。 */
const doneEvent = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });

test("不扫描分支历史 DONE；新进度保存且重复幂等", async () => {
  const h = await executionFixture();
  h.branch.push({ type: "message", ...doneEvent("[DONE:TASK-2]") });
  await h.emit("before_agent_start"); await h.emit("turn_end", doneEvent("[DONE:TASK-1]"));
  assert.equal(h.disk().phase, "implementation"); assert.deepEqual(h.disk().completedTasks, ["TASK-1"]);
  const revision = h.disk().revision;
  await h.emit("turn_end", doneEvent("[DONE:TASK-1]")); assert.equal(h.disk().revision, revision);
  await h.emit("turn_end", doneEvent("[DONE:TASK-2]"));
  assert.equal(h.disk().phase, "verification"); assert.deepEqual(h.disk().completedTasks, ["TASK-1", "TASK-2"]);
});

test("执行过程中 revise 后重新批准，旧轮 DONE 不写新 revision", async () => {
  const h = await executionFixture(); await h.emit("before_agent_start");
  await h.run("revise tasks");
  const revised = h.disk();
  const submitted = transition(revised, { type: "submit", sha256: hash("## TASK-1\n## TASK-2\n") });
  assert.ok(submitted.ok); writeFileSync(h.file("demo", "state.json"), JSON.stringify(submitted.state));
  await h.run("status"); await h.run("approve");
  await h.emit("turn_end", doneEvent("[DONE:TASK-1]")); assert.deepEqual(h.disk().completedTasks, []);
});

test("恢复不消费上一轮 DONE；未知任务明确诊断", async () => {
  const h = await executionFixture(); await h.emit("before_agent_start"); await h.emit("session_tree");
  await h.emit("turn_end", doneEvent("[DONE:TASK-1]")); assert.deepEqual(h.disk().completedTasks, []);
  await h.emit("before_agent_start"); const count = h.notices.length;
  await h.emit("turn_end", doneEvent("[DONE:TASK-unknown]")); assert.ok(h.notices.length > count);
});

test("执行阶段冻结 tasks 定义，必须 revise 才能修改", async () => {
  const h = await executionFixture();
  const result = await h.emit("tool_call", { toolName: "write", input: { path: h.file("demo", "tasks.md") } });
  assert.equal((result as { block?: boolean })?.block, true);
});


test("验证批准与 revise verification 保留进度，revise tasks 清理进度", async () => {
  const h = await executionFixture(); await h.emit("before_agent_start");
  await h.emit("turn_end", doneEvent("[DONE:TASK-1] [DONE:TASK-2]"));
  const submitted = transition(h.disk(), { type: "submit", sha256: hash("verification") });
  assert.ok(submitted.ok); writeFileSync(h.file("demo", "verification.md"), "verification");
  writeFileSync(h.file("demo", "state.json"), JSON.stringify(submitted.state));
  await h.run("status"); await h.run("approve"); assert.equal(h.disk().phase, "complete");
  assert.deepEqual(h.disk().completedTasks, ["TASK-1", "TASK-2"]);
  await h.run("revise verification"); assert.deepEqual(h.disk().completedTasks, ["TASK-1", "TASK-2"]);
  await h.run("revise tasks"); assert.deepEqual(h.disk().completedTasks, []);
});

test("切换规格或 agent_end 后，迟到的 DONE 不落盘", async () => {
  const h = await executionFixture(); await h.emit("before_agent_start"); h.fixture("second", "tasks");
  await h.run("use second"); await h.run("approve");
  await h.emit("turn_end", doneEvent("[DONE:TASK-1]")); assert.deepEqual(h.disk("second").completedTasks, []);
  await h.run("use demo"); await h.emit("before_agent_start"); await h.emit("agent_end");
  await h.emit("turn_end", doneEvent("[DONE:TASK-1]")); assert.deepEqual(h.disk().completedTasks, []);
});

/** 直接观察发给模型的消息，而不是仅检查曾触发 before_agent_start。 */
async function modelContext(h: ReturnType<typeof harness>, messages: unknown[] = []) {
  const result = await h.emit("context", { messages }) as { messages: Array<{ role: string; customType?: string; content?: unknown }> };
  assert.ok(result, "context handler must provide current guidance");
  return result.messages;
}

test("阶段正文去重、切换替换、压缩后补回且 stop 清理", async () => {
  const h = harness(); h.fixture(); await h.run("use demo"); await h.run("revise requirements");
  const user = { role: "user", content: "keep me", timestamp: 1 };
  const first = await modelContext(h, [user]);
  const procedure = first.find((m) => m.customType === "spec-mode-procedure");
  assert.ok(procedure); assert.match(String(procedure.content), /REQ-/);
  const twice = await modelContext(h, [...first, procedure]);
  assert.equal(twice.filter((m) => m.customType === "spec-mode-procedure").length, 1);
  assert.ok(twice.includes(user));
  const restored = await modelContext(h, [user]);
  assert.equal(restored.find((m) => m.customType === "spec-mode-procedure")?.content, procedure.content);
  h.fixture("other", "design"); await h.run("use other"); await h.run("revise design");
  const next = await modelContext(h, twice);
  assert.equal(next.filter((m) => m.customType === "spec-mode-procedure").length, 1);
  assert.notEqual(next.find((m) => m.customType === "spec-mode-procedure")?.content, procedure.content);
  await h.run("stop"); assert.deepEqual(await modelContext(h, next), [user]);
});

test("待批仅等待或 revise，complete 不生成文档或虚报验证", async () => {
  const h = harness(); h.fixture("demo", "verification"); await h.run("use demo");
  const waiting = await modelContext(h);
  assert.equal(waiting.some((m) => m.customType === "spec-mode-procedure"), false);
  assert.match(JSON.stringify(waiting), /\/spec approve/);
  assert.match(JSON.stringify(waiting), /\/spec revise/);
  await h.run("approve");
  const complete = await modelContext(h, waiting);
  assert.equal(complete.some((m) => m.customType === "spec-mode-procedure"), false);
  assert.doesNotMatch(JSON.stringify(complete), /complete\.md/);
});

test("阶段方法读取失败显式阻断而非沿用旧指令", async () => {
  const h = harness(); h.fixture(); await h.run("use demo"); await h.run("revise requirements");
  const originalRead = fs.readFileSync;
  const read = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).includes("procedures")) throw new Error("injected procedure failure");
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  try {
    const messages = await modelContext(h);
    assert.match(JSON.stringify(messages), /injected procedure failure/);
    assert.deepEqual(h.tools(), []);
    assert.equal((await h.emit("tool_call", { toolName: "read", input: {} }) as { block: boolean }).block, true);
  } finally { read.mock.restore(); syncBuiltinESMExports(); }
});

// ── 交互入口：菜单、Tab 补全与审批请求工具 ─────────────────────────

test("无参数 /spec 在非交互模式列出当前可用动作", async () => {
  const h = harness({ hasUI: false });
  await h.run("");
  assert.match(h.notices.at(-1)!.text, /\/spec new/);
  h.fixture();
  await h.run("use demo");
  await h.run("");
  assert.match(h.notices.at(-1)!.text, /approve/);
});

test("无参数 /spec 菜单选中批准即可完成审批，不必手打 approve", async () => {
  const h = harness(); h.fixture();
  h.ctx.ui.select = async (_title, choices) => choices[0];
  await h.run("use demo");
  await h.run("");
  assert.equal(h.disk().phase, "design");
  assert.equal(h.disk().artifacts.requirements.approvalKind, "human");
});

test("菜单取消不产生任何修改", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  const before = h.disk();
  h.ctx.ui.select = async () => undefined;
  await h.run("");
  assert.deepEqual(h.disk(), before);
  assert.match(h.notices.at(-1)!.text, /取消/);
});

test("待批时一级补全只给合法动作，首项是批准", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  const items = await h.complete("");
  assert.ok(items && items.length > 0);
  assert.equal(items[0].value, "approve");
  assert.ok(!items.some((item) => item.value === "continue"));
  assert.ok(items.every((item) => item.label.length > 0));
});

test("未激活时一级补全提供新建，并按需提供激活", async () => {
  // 补全回调没有 ctx，需要先经过一次带 ctx 的事件才能知道项目目录
  const empty = harness(); await empty.emit("session_start");
  assert.deepEqual((await empty.complete(""))?.map((item) => item.value), ["new"]);
  const h = harness(); h.fixture("alpha"); h.fixture("beta"); await h.emit("session_start");
  assert.deepEqual((await h.complete(""))?.map((item) => item.value), ["new", "use "]);
});

test("use 与 revise 的二级补全列出磁盘规格与可回退阶段", async () => {
  const h = harness(); h.fixture(); h.fixture("second"); await h.run("use demo");
  const specs = await h.complete("use ");
  assert.deepEqual(specs?.map((item) => item.value).sort(), ["use demo", "use second"]);
  assert.equal(await h.complete("use zzz"), null);
  assert.deepEqual((await h.complete("revise "))?.map((item) => item.value), ["revise requirements"]);
  assert.equal(await h.complete("revise design"), null);
});

test("未知子命令明确报告并回退到动作菜单", async () => {
  const h = harness(); h.fixture();
  h.ctx.ui.select = async () => undefined;
  await h.run("usee demo");
  assert.equal(h.notices[0].level, "warning");
  assert.match(h.notices[0].text, /usee/);
});

test("/spec new 通过输入框询问名称与标题，不再需要 --title", async () => {
  const h = harness();
  const answers = ["checkout-flow", "结算流程"];
  h.ctx.ui.input = async () => answers.shift();
  await h.run("new");
  assert.equal(h.disk("checkout-flow").title, "结算流程");
  assert.equal(h.disk("checkout-flow").phase, "requirements");
});

test("/spec new 的旧 --title 仍然生效，不静默忽略", async () => {
  const h = harness();
  let asked = 0;
  h.ctx.ui.input = async () => { asked += 1; return "ignored"; };
  await h.run('new legacy-flow --title "旧标题"');
  assert.equal(h.disk("legacy-flow").title, "旧标题");
  assert.equal(asked, 0);
});

test("/spec new 输入非法名称时明确拒绝", async () => {
  const h = harness();
  h.ctx.ui.input = async () => "Not A Slug";
  await h.run("new");
  assert.equal(h.notices.at(-1)!.level, "error");
  assert.ok(!existsSync(join(h.ctx.cwd, ".pi", "specs", "Not A Slug")));
});

test("/spec use 无参数时从磁盘列表中选择", async () => {
  const h = harness(); h.fixture("alpha"); h.fixture("beta");
  h.ctx.ui.select = async (_title, choices) => choices.find((choice) => choice.startsWith("beta"));
  await h.run("use");
  assert.match(h.notices.at(-1)!.text, /beta/);
});

test("/spec use 在没有任何规格时明确说明", async () => {
  const h = harness();
  await h.run("use");
  assert.equal(h.notices.at(-1)!.level, "warning");
});

test("/spec revise 无参数时只列出可回退阶段", async () => {
  const h = harness(); h.fixture("demo", "design"); await h.run("use demo");
  let offered: string[] = [];
  h.ctx.ui.select = async (_title, choices) => { offered = [...choices]; return choices[0]; };
  await h.run("revise");
  assert.equal(offered.length, 2);
  assert.equal(h.disk().phase, "requirements");
  assert.equal(h.disk().status, "drafting");
});

test("spec_request_approval 弹确认框并完成批准", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  assert.ok(h.tools().includes(APPROVAL_TOOL));
  const result = await h.invoke(APPROVAL_TOOL) as { details: { approved: boolean } };
  assert.equal(result.details.approved, true);
  assert.equal(h.disk().phase, "design");
  assert.equal(h.disk().artifacts.requirements.approvalKind, "human");
});

test("用户取消审批请求时不产生批准，文档保持待批", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  h.ctx.ui.confirm = async () => false;
  const result = await h.invoke(APPROVAL_TOOL) as { details: { approved: boolean } };
  assert.equal(result.details.approved, false);
  assert.equal(h.disk().status, "awaiting_approval");
  assert.equal(h.disk().artifacts.requirements.approvedSha256, undefined);
});

test("非交互模式不弹审批框，也不假装批准", async () => {
  const h = harness({ hasUI: false }); h.fixture(); await h.run("use demo");
  const result = await h.invoke(APPROVAL_TOOL) as { details: { approved: boolean } };
  assert.equal(result.details.approved, false);
  assert.equal(h.disk().status, "awaiting_approval");
});

test("审批请求工具只在待批阶段暴露，直接误调用也被拒绝", async () => {
  const h = harness(); await h.emit("session_start");
  assert.ok(!h.tools().includes(APPROVAL_TOOL));
  h.fixture(); await h.run("use demo");
  assert.ok(h.tools().includes(APPROVAL_TOOL));
  await h.run("approve");
  assert.ok(!h.tools().includes(APPROVAL_TOOL));
  const result = await h.invoke(APPROVAL_TOOL) as { details: { approved: boolean } };
  assert.equal(result.details.approved, false);
  assert.equal(h.disk().phase, "design");
});

test("审批请求遇到确认期间文档被改时拒绝批准", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  h.ctx.ui.confirm = async () => {
    writeFileSync(h.file("demo", "requirements.md"), "changed");
    return true;
  };
  const result = await h.invoke(APPROVAL_TOOL) as { details: { approved: boolean } };
  assert.equal(result.details.approved, false);
  assert.equal(h.disk().phase, "requirements");
  assert.equal(h.disk().status, "drafting");
});

// ── 状态落在文档里，但真相仍是 state.json ────────────────────────

/** 取文档 frontmatter 之后的正文，用于验证「只改头不算改正文」。 */
function bodyOf(text: string): string {
  return text.split("\n---\n").at(-1) ?? "";
}

test("新建规格：四份文档一开始就带派生 frontmatter", async () => {
  const h = harness();
  h.ctx.ui.input = async () => "demo";
  h.ctx.ui.select = async (_title, choices) => choices[0];
  await h.run("new demo");
  assert.equal(h.disk("demo").schema, SCHEMA_V2);
  for (const artifact of ["requirements", "design", "tasks", "verification"] as Artifact[]) {
    const text = readFileSync(h.file("demo", `${artifact}.md`), "utf8");
    assert.match(text, /^---\n# /, `${artifact}.md 应带提示行`);
    assert.match(text, new RegExp(`^artifact: ${artifact}$`, "m"));
    assert.match(text, /^phase: requirements$/m);
    assert.match(text, /^status: drafting$/m);
    assert.match(text, /^approval: draft$/m);
  }
  // 没有手工改动就不该报「校准」
  assert.ok(!h.notices.some((n) => /校准/.test(n.text)));
});

test("提交与批准把审批状态写进文档头", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  const path = h.file("demo", "requirements.md");
  assert.match(readFileSync(path, "utf8"), /^status: awaiting_approval$/m);
  assert.match(readFileSync(path, "utf8"), /^approval: pending$/m);
  await h.run("approve");
  const approved = readFileSync(path, "utf8");
  assert.match(approved, /^phase: design$/m);
  assert.match(approved, /^status: drafting$/m);
  assert.match(approved, /^approval: human$/m);
  assert.match(approved, /^approved_at: \d{4}-/m);
  assert.equal(bodyOf(approved), "requirements");
});

test("任务进度写进 tasks.md 头，不让已批准的任务定义失效", async () => {
  const h = await executionFixture();
  await h.emit("before_agent_start");
  await h.emit("turn_end", doneEvent("[DONE:TASK-1]"));
  const text = readFileSync(h.file("demo", "tasks.md"), "utf8");
  assert.match(text, /^tasks_done: 1\/2$/m);
  assert.match(text, /^status: in_progress$/m);
  assert.match(text, /^approval: human$/m);
  // 进度只改派生头，正文未变，所以执行授权仍然有效
  assert.equal(h.disk().phase, "implementation");
  assert.equal(h.disk().artifacts.tasks.approvedSha256, hash("## TASK-1\n## TASK-2\n"));
  assert.equal(bodyOf(text), "## TASK-1\n## TASK-2\n");
});

test("手工改坏文档头不改状态，重新激活时按 state.json 回正", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  const path = h.file("demo", "requirements.md");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, `---\nphase: complete\nstatus: done\napproval: human\n---\n${bodyOf(original)}`);
  await h.run("stop");
  await h.run("use demo");
  const repaired = readFileSync(path, "utf8");
  assert.match(repaired, /^phase: requirements$/m);
  assert.match(repaired, /^status: awaiting_approval$/m);
  assert.match(repaired, /^approval: pending$/m);
  assert.equal(h.disk().status, "awaiting_approval");
  assert.ok(h.notices.some((n) => /校准/.test(n.text)));
});

test("删掉文档头不算正文改动，已批准的上游不回退", async () => {
  const h = harness(); h.fixture("demo", "design"); await h.run("use demo");
  const path = h.file("demo", "requirements.md");
  writeFileSync(path, bodyOf(readFileSync(path, "utf8")));
  await h.emit("before_agent_start");
  assert.equal(h.disk().phase, "design");
  assert.equal(h.disk().artifacts.requirements.approvedSha256, hash("requirements"));
  await h.emit("session_tree");
  assert.match(readFileSync(path, "utf8"), /^phase: design$/m);
});

test("v1 记录可读且升级为当前协议", async () => {
  const h = harness(); h.fixture();
  const state = h.disk() as StateFile & { schema: string };
  state.schema = SCHEMA_V1;
  writeFileSync(h.file("demo", "state.json"), JSON.stringify(state));
  const loaded = loadState(h.ctx.cwd, "demo");
  assert.equal(loaded.schema, SCHEMA_V2);
  assert.equal(loaded.status, "awaiting_approval");
  await h.run("use demo");
  await h.run("approve");
  assert.equal(h.disk().schema, SCHEMA_V2);
});

test("派生 frontmatter 写失败时明确上报，state.json 仍已落盘", async () => {
  const h = harness(); h.fixture(); await h.run("use demo");
  const originalWrite = fs.writeFileSync;
  const write = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith(".md")) throw new Error("injected frontmatter failure");
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  try {
    await h.run("approve");
  } finally {
    write.mock.restore(); syncBuiltinESMExports();
  }
  assert.equal(h.disk().phase, "design");
  assert.ok(h.notices.some((n) => n.level === "warning" && /派生 frontmatter 写入失败/.test(n.text)));
});
