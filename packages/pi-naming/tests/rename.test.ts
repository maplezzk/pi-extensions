import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createSurfaceRenameContext, resolveTerminalRenameTargets, TERMINAL_RENAME_CONTEXT_ENV, type TerminalRenameTarget } from "pi-terminal-mux";
import { parseConfig } from "../src/config.ts";
import { registerNaming, registerNamingConfigCommand, type TerminalNamingAdapter } from "../src/index.ts";
import type { SessionNameRequest } from "../src/session-name.ts";

// 配置面板要用 Pi 的 SettingsList 主题，测试里先初始化一次。
initTheme();

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
    sessionManager: {
      getBranch: () => messages.map((content) => ({ type: "message", message: { role: "user", content } })),
      getSessionId: () => "session-1",
    },
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

test("配置面板保存 targets 后，自动与手动入口只作用于保存的目标", async () => {
  const menu = harness();
  let saved = parseConfig({});
  /** 用键盘驱动真实面板：下移到「命名 session」那一行再回车原地切换。 */
  const drivePanel = (element: { handleInput(data: string): void }): void => {
    element.handleInput("\u001b[B");
    element.handleInput("\u001b[B");
    element.handleInput("\r");
  };
  Object.assign(menu.ctx.ui, {
    custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { handleInput(data: string): void }) => {
      // 面板只用到 theme.fg / theme.bold 包一层文字，返回原文即可。
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const component = factory({ requestRender: () => undefined }, theme, {}, () => undefined);
      drivePanel(component);
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
    loadTerminal: async () => assert.fail("terminal must not load when only the session target is on"),
    requestName: async () => "Automatic session",
  });
  reloaded.events.get("session_start")!({}, reloaded.ctx);
  reloaded.events.get("input")!({ text: "Task", source: "interactive" }, reloaded.ctx);
  await flush();
  assert.equal(reloaded.name(), "Automatic session");
  assert.equal(reloaded.renamed.length, 0);
});

test("面板改动写入运行期配置后，下一个命名请求立即生效，不用 /reload", async () => {
  const h = harness(["Task"]);
  const runtime = { config: parseConfig({}) };
  const requests: SessionNameRequest[] = [];
  await registerNaming(h.pi, runtime.config, {
    runtime,
    loadTerminal: async () => h.terminal,
    requestName: async (request) => { requests.push(request); return "Generated"; },
  });

  // 模拟面板把 targets 与标题语言改掉：改的就是运行期持有者，没有 reload。
  runtime.config = parseConfig({ targets: { session: false, workspace: true, tab: false }, title: { language: "English" } });
  // 不带参数走模型命名，才能看到 title 配置是否被重新读取。
  await h.commands.get("rename")!.handler("", h.ctx);

  assert.equal(h.name(), undefined);
  assert.deepEqual(h.renamed.map(([reference]) => reference.operation), ["workspace"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.title?.language, "English");
});

test("终端目标在加载时关着、面板打开后不需要 reload 也能改名", async () => {
  const h = harness();
  // 加载时只开 session，终端适配器此时不应被加载。
  const runtime = { config: parseConfig({ targets: { session: true, workspace: false, tab: false } }) };
  let terminalLoads = 0;
  await registerNaming(h.pi, runtime.config, {
    runtime,
    loadTerminal: async () => { terminalLoads++; return h.terminal; },
  });
  assert.equal(terminalLoads, 0);

  // 面板把 workspace 打开；下一次 /rename 应加载终端并改名。
  runtime.config = parseConfig({ targets: { session: false, workspace: true, tab: false } });
  await h.commands.get("rename")!.handler("Live terminal", h.ctx);
  assert.equal(terminalLoads, 1);
  assert.deepEqual(h.renamed.map(([reference]) => reference.operation), ["workspace"]);
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

test("入口常驻注册，开关在调用时生效：关掉手动命名只报告原因，不丢命令", async () => {
  const h = harness();
  await registerNaming(h.pi, parseConfig({ automaticNaming: false, manualNaming: false }), {
    loadTerminal: async () => assert.fail("unexpected load"),
    requestName: async () => assert.fail("unexpected model"),
  });
  // /rename 必须还在：Pi 没有内置 /rename 可回退，命令凭空消失用户只会以为插件坏了。
  assert.deepEqual([...h.commands.keys()], ["rename"]);
  await h.commands.get("rename")!.handler("Name", h.ctx);
  assert.equal(h.name(), undefined);
  assert.match(h.notices.at(-1) ?? "", /手动命名已关闭/);
});

test("所有目标都关着时不改名也不花模型调用，只报告原因", async () => {
  const h = harness(["Task"]);
  await registerNaming(h.pi, parseConfig({ targets: { session: false, workspace: false, tab: false } }), {
    loadTerminal: async () => assert.fail("unexpected load"),
    requestName: async () => assert.fail("unexpected model"),
  });
  await h.commands.get("rename")!.handler("", h.ctx);
  assert.equal(h.name(), undefined);
  assert.equal(h.renamed.length, 0);
  assert.match(h.notices.at(-1) ?? "", /没有启用任何命名目标/);
});

test("面板把入口开关打开后，不需要 /reload 就能用", async () => {
  // 加载时两个入口都关着：以前这里会直接 return，之后怎么改都没反应。
  const manual = harness();
  const manualRuntime = { config: parseConfig({ automaticNaming: false, manualNaming: false }) };
  await registerNaming(manual.pi, manualRuntime.config, {
    runtime: manualRuntime,
    loadTerminal: async () => manual.terminal,
    requestName: async () => assert.fail("unexpected model"),
  });
  // 面板打开手动命名：下一个 /rename 立即生效。
  manualRuntime.config = parseConfig({ automaticNaming: false, manualNaming: true });
  await manual.commands.get("rename")!.handler("Manual title", manual.ctx);
  assert.equal(manual.name(), "Manual title");

  const automatic = harness();
  const automaticRuntime = { config: parseConfig({ automaticNaming: false, manualNaming: false }) };
  await registerNaming(automatic.pi, automaticRuntime.config, {
    runtime: automaticRuntime,
    loadTerminal: async () => automatic.terminal,
    requestName: async () => "Generated",
  });
  // 面板打开自动命名：下一次输入立即生效。
  automaticRuntime.config = parseConfig({ automaticNaming: true, manualNaming: false });
  automatic.events.get("session_start")!({}, automatic.ctx);
  automatic.events.get("input")!({ text: "Task", source: "interactive" }, automatic.ctx);
  await flush();
  assert.equal(automatic.name(), "Generated");
});

test("自动与手动可分别启用", async () => {
  for (const automaticNaming of [true, false]) {
    const h = harness();
    await registerNaming(h.pi, parseConfig({ automaticNaming, manualNaming: !automaticNaming }), { loadTerminal: async () => h.terminal });
    // 两个入口都已注册；开关只决定调用时走不走实际命名。
    assert.equal(h.events.has("input"), true);
    assert.equal(h.commands.has("rename"), true);
    await h.commands.get("rename")!.handler("Manual", h.ctx);
    assert.equal(h.name(), automaticNaming ? undefined : "Manual");
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
