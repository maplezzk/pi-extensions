import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createSurfaceRenameContext, resolveTerminalRenameTargets, TERMINAL_RENAME_CONTEXT_ENV, type TerminalRenameTarget } from "pi-terminal-mux";
import { parseConfig } from "../src/config.ts";
import { registerNaming, registerNamingConfigCommand, type TerminalNamingAdapter } from "../src/index.ts";
import type { SessionNameRequest } from "../src/session-name.ts";

type Input = { text?: string; source?: string };
type Handler = (event: Input, ctx: ExtensionContext) => unknown;

/** 最小宿主，保存 session 状态、命令与通知。 */
function harness(messages: string[] = []) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
  const notices: string[] = [];
  const renamed: Array<[TerminalRenameTarget, string]> = [];
  let name: string | undefined;
  const pi = {
    on: (event: string, handler: Handler) => events.set(event, handler),
    registerCommand: (command: string, handler: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(command, handler),
    getSessionName: () => name,
    setSessionName: (value: string) => { name = value; },
    sendMessage: (message: { content: string }) => notices.push(message.content),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: { getBranch: () => messages.map((content) => ({ type: "message", message: { role: "user", content } })) },
  } as unknown as ExtensionCommandContext;
  const terminal: TerminalNamingAdapter = {
    resolve: (options) => resolveTerminalRenameTargets({ ...options, backend: "cmux", env: {
      CMUX_SURFACE_ID: "own-tab", CMUX_WORKSPACE_ID: "own-workspace",
    } }),
    rename: (reference, title) => { renamed.push([reference, title]); return { status: "renamed", reference }; },
  };
  return { pi, ctx, events, commands, notices, renamed, terminal, name: () => name };
}

/** 等待 fire-and-forget 命名的微任务结束，不依赖固定睡眠时长。 */
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("只注册 /rename，显式名称同步三个目标且不调用模型", async () => {
  const h = harness();
  const label = "Explicit title longer than fifteen characters";
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => assert.fail("unexpected model") });
  assert.deepEqual([...h.commands.keys()], ["rename"]);
  await h.commands.get("rename")!.handler(label, h.ctx);
  assert.equal(h.name(), label);
  assert.deepEqual(h.renamed.map(([, title]) => title), [label, label]);
});

test("命名仅按 targets 请求明确终端目标，不转换后端环境变量", async () => {
  const h = harness();
  let options: Parameters<TerminalNamingAdapter["resolve"]>[0] | undefined;
  h.terminal.resolve = (value) => { options = value; return []; };
  await registerNaming(h.pi, parseConfig({ targets: { session: false, workspace: true, tab: false } }), { loadTerminal: async () => h.terminal });
  await h.commands.get("rename")!.handler("Workspace title", h.ctx);
  assert.deepEqual(options, { tab: false, workspace: true });
});

test("配置菜单保存 targets 后，reload 的自动与手动入口只作用于保存的目标", async () => {
  const menu = harness();
  let saved = parseConfig({});
  let selectedTarget = false;
  Object.assign(menu.ctx.ui, {
    select: async (_title: string, choices: string[]) => {
      if (!selectedTarget) {
        selectedTarget = true;
        return choices.find((choice) => /session|会话/.test(choice));
      }
      return choices.at(-1);
    },
    input: async () => assert.fail("unexpected config input"),
  });
  registerNamingConfigCommand(menu.pi, {
    load: () => saved,
    save: (config) => { saved = config; },
    path: () => "/configured/pi-naming.json",
  });
  await menu.commands.get("config:naming")!.handler("", menu.ctx);
  assert.equal(saved.targets.session, false);

  const manual = harness();
  await registerNaming(manual.pi, saved, { loadTerminal: async () => manual.terminal });
  await manual.commands.get("rename")!.handler("Saved target", manual.ctx);
  assert.equal(manual.name(), undefined);
  assert.deepEqual(manual.renamed.map(([reference]) => reference.operation), ["workspace", "tab"]);

  const reloaded = harness();
  await registerNaming(reloaded.pi, parseConfig({ automaticNaming: true, manualNaming: false, targets: { workspace: false, tab: false } }), {
    loadTerminal: async () => assert.fail("terminal must not load after reload"),
    requestName: async () => "Automatic session",
  });
  reloaded.events.get("session_start")!({}, reloaded.ctx);
  reloaded.events.get("input")!({ text: "Task", source: "interactive" }, reloaded.ctx);
  await flush();
  assert.equal(reloaded.name(), "Automatic session");
  assert.equal(reloaded.renamed.length, 0);
});

test("首条真实输入和手动生成使用相同目标、标题配置", async () => {
  for (const automatic of [true, false]) {
    const h = harness(automatic ? [] : ["Task"]);
    const config = parseConfig({ title: { language: "English" } });
    const requests: SessionNameRequest[] = [];
    await registerNaming(h.pi, config, { loadTerminal: async () => h.terminal, requestName: async (request) => {
      requests.push(request); return "Generated";
    } });
    h.events.get("session_start")!({}, h.ctx);
    if (automatic) {
      h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
      await flush();
      h.events.get("input")!({ text: "Second task", source: "interactive" }, h.ctx);
      await flush();
    } else await h.commands.get("rename")!.handler("", h.ctx);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.userMessages, ["Task"]);
    assert.deepEqual(requests[0]?.title, config.title);
    assert.equal(h.name(), "Generated");
    assert.equal(h.renamed.length, 2);
  }
});

test("手动重新命名传入当前分支全部用户消息，包括纠正与流程性跟进", async () => {
  const messages = ["修复订单导出", "纠正：是订单筛选，不是导出", "继续", "验证一下", "提交"];
  const h = harness(messages);
  const requests: SessionNameRequest[] = [];
  h.pi.setSessionName("旧标题");
  await registerNaming(h.pi, parseConfig({}), {
    loadTerminal: async () => h.terminal,
    requestName: async (request) => { requests.push(request); return "修复订单筛选"; },
  });
  await h.commands.get("rename")!.handler("", h.ctx);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.userMessages, messages);
  assert.equal(h.name(), "修复订单筛选");
});

test("session-only 不加载终端；目标开关不阻止其他目标", async () => {
  const h = harness();
  await registerNaming(h.pi, parseConfig({ targets: { workspace: false, tab: false } }), {
    loadTerminal: async () => assert.fail("terminal must not load"),
  });
  await h.commands.get("rename")!.handler("Session only", h.ctx);
  assert.equal(h.name(), "Session only");
  const terminalOnly = harness();
  await registerNaming(terminalOnly.pi, parseConfig({ targets: { session: false, workspace: false } }), {
    loadTerminal: async () => terminalOnly.terminal,
  });
  await terminalOnly.commands.get("rename")!.handler("Tab only", terminalOnly.ctx);
  assert.equal(terminalOnly.name(), undefined);
  assert.equal(terminalOnly.renamed.length, 1);
});

test("禁用入口或全部目标时不注册；自动与手动可分别启用", async () => {
  for (const config of [{ automaticNaming: false, manualNaming: false }, { targets: { session: false, workspace: false, tab: false } }]) {
    const h = harness();
    await registerNaming(h.pi, parseConfig(config), { loadTerminal: async () => assert.fail("unexpected load") });
    assert.equal(h.events.size, 0);
    assert.equal(h.commands.size, 0);
  }
  for (const automaticNaming of [true, false]) {
    const h = harness();
    await registerNaming(h.pi, parseConfig({ automaticNaming, manualNaming: !automaticNaming }), { loadTerminal: async () => h.terminal });
    assert.equal(h.events.has("input"), automaticNaming);
    assert.equal(h.commands.has("rename"), !automaticNaming);
  }
});

test("一个终端失败不影响 session 或其他终端，错误不伪报成功", async () => {
  const h = harness();
  h.terminal.rename = (reference) => {
    if (reference.operation === "workspace") throw new Error("workspace failure");
    return { status: "renamed", reference };
  };
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal });
  await h.commands.get("rename")!.handler("Name", h.ctx);
  assert.equal(h.name(), "Name");
  assert.ok(h.notices.some((message) => message.includes("workspace failure")));
});

test("没有终端、加载失败或协议损坏仍能改 session，并报告原因", async () => {
  for (const failure of ["headless", "load", "context"]) {
    const h = harness();
    h.terminal.resolve = () => {
      if (failure === "context") throw new Error("invalid context");
      return [{ status: "skipped", operation: "tab", reason: "unsupported" }];
    };
    await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => {
      if (failure === "load") throw new Error("load failed");
      return h.terminal;
    } });
    h.events.get("session_start")!({}, h.ctx);
    await h.commands.get("rename")!.handler("Name", h.ctx);
    assert.equal(h.name(), "Name");
    assert.ok(h.notices.length > 1);
  }
});

for (const backend of ["cmux", "tmux", "herdr"] as const) {
  test(`${backend} 组合子代理只修改获授目标，绝不改 workspace`, async () => {
    const h = harness();
    const context = createSurfaceRenameContext("child", backend);
    h.terminal.resolve = (options) => resolveTerminalRenameTargets({ ...options, backend,
      env: { [TERMINAL_RENAME_CONTEXT_ENV]: JSON.stringify(context) } });
    await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal });
    await h.commands.get("rename")!.handler("Child", h.ctx);
    assert.equal(h.name(), "Child");
    assert.ok(h.renamed.every(([target]) => target.operation !== "workspace" && target.id === "child"));
    assert.equal(h.renamed.length, backend === "cmux" || backend === "herdr" ? 1 : 0);
    assert.ok(h.notices.some((message) => /共享|shared/.test(message)));
  });
}

for (const lifecycle of ["session_start", "session_shutdown", "session_tree"]) {
  test(`${lifecycle} 后丢弃旧结果和旧错误`, async () => {
    for (const reject of [false, true]) {
      const h = harness(["Task"]);
      let finish!: (title: string) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
      await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
      const running = h.commands.get("rename")!.handler("", h.ctx);
      h.events.get(lifecycle)!({}, h.ctx);
      if (reject) fail(new Error("stale")); else finish("Stale");
      await running;
      assert.equal(h.name(), undefined);
      assert.equal(h.renamed.length, 0);
      assert.deepEqual(h.notices, []);
    }
  });
}

test("后续手动命令优先于正在生成的自动标题", async () => {
  const h = harness();
  let finish!: (title: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
  await h.commands.get("rename")!.handler("Manual", h.ctx);
  finish("Stale");
  await flush();
  assert.equal(h.name(), "Manual");
  assert.deepEqual(h.renamed.map(([, name]) => name), ["Manual", "Manual"]);
});

test("已有名称、空输入、扩展输入和已有历史不会触发自动命名", async () => {
  for (const scenario of ["named", "blank", "extension", "history"]) {
    const h = harness(scenario === "history" ? ["History"] : []);
    if (scenario === "named") h.pi.setSessionName("Existing");
    await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => assert.fail("unexpected request") });
    h.events.get("session_start")!({}, h.ctx);
    h.events.get("input")!({ text: scenario === "blank" ? " " : "Task", source: scenario === "extension" ? "extension" : "interactive" }, h.ctx);
    await flush();
    assert.equal(h.renamed.length, 0);
  }
});

test("无 UI 模式仍可看到终端跳过原因", async () => {
  const h = harness();
  Object.assign(h.ctx, { hasUI: false });
  h.terminal.resolve = () => [{ status: "skipped", operation: "tab", reason: "unverified" }];
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal });
  await h.commands.get("rename")!.handler("Name", h.ctx);
  assert.ok(h.notices.some((message) => /归属|ownership/.test(message)));
});


test("生成期间原生命名生效后自动结果不再改任何目标", async () => {
  const h = harness();
  let finish!: (title: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
  h.events.get("session_start")!({}, h.ctx);
  h.events.get("input")!({ text: "Task", source: "interactive" }, h.ctx);
  h.pi.setSessionName("Native name");
  finish("Stale");
  await flush();
  assert.equal(h.name(), "Native name");
  assert.equal(h.renamed.length, 0);
});

test("后续手动命令取代旧手动请求，使用捕获的终端目标", async () => {
  const h = harness(["Task"]);
  let finish!: (title: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  await registerNaming(h.pi, parseConfig({}), { loadTerminal: async () => h.terminal, requestName: async () => pending });
  const old = h.commands.get("rename")!.handler("", h.ctx);
  await h.commands.get("rename")!.handler("New", h.ctx);
  finish("Old");
  await old;
  assert.equal(h.name(), "New");
  assert.deepEqual(h.renamed.map(([, title]) => title), ["New", "New"]);
});

test("标题超时保留旧状态，错误可见", async () => {
  const h = harness(["Task"]);
  const timeoutMs = 5;
  await registerNaming(h.pi, parseConfig({ title: { timeoutMs } }), {
    loadTerminal: async () => h.terminal,
    requestName: async () => new Promise<string>(() => undefined),
  });
  await h.commands.get("rename")!.handler("", h.ctx);
  assert.equal(h.name(), undefined);
  assert.equal(h.renamed.length, 0);
  assert.ok(h.notices.some((message) => /超时|timed out/.test(message)));
});
