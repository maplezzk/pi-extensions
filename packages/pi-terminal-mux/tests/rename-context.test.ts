import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSurfaceRenameContext, readSurfaceRenameContext, resolveTerminalRenameTargets,
  renameTerminalTarget, TERMINAL_RENAME_CONTEXT_ENV, type MuxBackend,
  type SurfaceRenameContext, type TerminalRenameTarget,
} from "../src/index.ts";

/** 构造不依赖本机环境的协议输入。 */
function contextEnv(context: SurfaceRenameContext): NodeJS.ProcessEnv {
  return { [TERMINAL_RENAME_CONTEXT_ENV]: JSON.stringify(context) };
}

test("普通会话解析自己的 workspace 和 tab ID，不使用焦点", () => {
  const targets = resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "cmux",
    env: { CMUX_SURFACE_ID: "surface:own", CMUX_WORKSPACE_ID: "workspace:own" } });
  assert.deepEqual(targets.map((result) => result.status === "ready" && result.reference.id), ["workspace:own", "surface:own"]);
  assert.deepEqual(resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "cmux", env: {} }), [
    { status: "skipped", operation: "workspace", reason: "missing-id" },
    { status: "skipped", operation: "tab", reason: "missing-id" },
  ]);
});

test("明确目标解析忽略旧环境开关，但关闭目标绝不产生结果", () => {
  for (const value of [undefined, "0", "1"]) {
    const env = {
      TMUX_PANE: "%own",
      HERDR_TAB_ID: "tab:own",
      HERDR_WORKSPACE_ID: "workspace:own",
      PI_SUBAGENT_RENAME_TMUX_WINDOW: value,
      PI_SUBAGENT_RENAME_TMUX_SESSION: value,
      PI_SUBAGENT_RENAME_HERDR_WORKSPACE: value,
    };
    const tmux = resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "tmux", env },
      (_command, args) => args.at(-1) === "#{window_id}" ? "@own" : "$own");
    assert.deepEqual(tmux.map((result) => result.status === "ready" && result.reference.id), ["$own", "@own"]);
    const herdr = resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "herdr", env });
    assert.deepEqual(herdr.map((result) => result.status === "ready" && result.reference.id), ["workspace:own", "tab:own"]);
  }
  assert.deepEqual(resolveTerminalRenameTargets({ tab: false, workspace: false, backend: "tmux", env: {
    TMUX_PANE: "%own", PI_SUBAGENT_RENAME_TMUX_WINDOW: "1", PI_SUBAGENT_RENAME_TMUX_SESSION: "1",
  } }), []);
});

for (const backend of ["tmux", "wezterm", "otty", "orca"] as MuxBackend[]) {
  test(`${backend} 子 pane 不授予共享 tab/window 改名权`, () => {
    const context = createSurfaceRenameContext("child-surface", backend);
    assert.equal(context.ownedTarget, null);
    assert.deepEqual(resolveTerminalRenameTargets({ tab: true, workspace: true, backend, env: contextEnv(context) }), [
      { status: "skipped", operation: "workspace", reason: "shared" },
      { status: "skipped", operation: "tab", reason: "unverified" },
    ]);
  });
}

for (const backend of ["cmux", "muxy", "zellij", "herdr"] as MuxBackend[]) {
  test(`${backend} 子进程只操作启动方提供的目标，忽略继承的父 ID`, () => {
    const context = createSurfaceRenameContext("child-surface", backend);
    const results = resolveTerminalRenameTargets({ tab: true, workspace: true, backend,
      env: { ...contextEnv(context), CMUX_SURFACE_ID: "parent", HERDR_TAB_ID: "parent-tab" } });
    assert.equal(results[0]?.status, "skipped");
    const result = results[1];
    assert.ok(result?.status === "ready");
    assert.equal(result.reference.id, "child-surface");
    assert.equal(result.reference.scope, "surface");
  });
}

test("未知版本、非法范围、损坏协议报错；旧启动方身份不扩大权限", () => {
  for (const value of ["{", "null", JSON.stringify({ version: 2 }), JSON.stringify({
    ...createSurfaceRenameContext("child", "tmux"), ownedTarget: { target: "tab", id: "parent" },
  })]) assert.throws(() => readSurfaceRenameContext({ [TERMINAL_RENAME_CONTEXT_ENV]: value }));
  const results = resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "cmux", env: {
    PI_SUBAGENT_ID: "legacy", CMUX_SURFACE_ID: "parent", CMUX_WORKSPACE_ID: "parent-workspace",
  } });
  assert.ok(results.every((result) => result.status === "skipped"));
  assert.equal(readSurfaceRenameContext({}), undefined);
});

test("headless、后端变更与关闭目标均不执行改名", () => {
  const context = createSurfaceRenameContext("headless:child", "cmux");
  assert.equal(context.backend, null);
  assert.equal(context.ownedTarget, null);
  assert.deepEqual(resolveTerminalRenameTargets({ tab: false, workspace: false, backend: null, env: {} }), []);
  const results = resolveTerminalRenameTargets({ tab: true, workspace: false, backend: "tmux",
    env: contextEnv(createSurfaceRenameContext("child", "cmux")) });
  assert.equal(results[0]?.status, "skipped");
  assert.equal(resolveTerminalRenameTargets({ tab: true, workspace: false, backend: "tmux", env: {} })[0]?.status, "skipped");
});

test("精确目标使用 argv 传递名称，失败逐目标返回", () => {
  const calls: Array<[string, string[]]> = [];
  const dependencies = { run: (command: string, args: string[]) => { calls.push([command, args]); }, renameOrca: () => true };
  const reference: TerminalRenameTarget = { backend: "cmux", operation: "workspace", target: "workspace", id: "own", scope: "shared" };
  const title = "title ' $(not-a-command)";
  assert.equal(renameTerminalTarget(reference, title, dependencies).status, "renamed");
  assert.deepEqual(calls, [["cmux", ["workspace-action", "--workspace", "own", "--action", "rename", "--title", title]]]);
  const failed = renameTerminalTarget(reference, title, { ...dependencies, run: () => { throw new Error("failure"); } });
  assert.deepEqual(failed, { status: "failed", operation: "workspace", error: "failure" });
  assert.equal(renameTerminalTarget({ ...reference, id: "" }, title, dependencies).status, "failed");
  assert.equal(calls.length, 1);
});

test("所有后端都按已捕获的 ID 执行各自的明确改名命令", () => {
  const calls: Array<[string, string[]]> = [];
  const run = (command: string, args: string[]) => { calls.push([command, args]); };
  const title = "Task";
  const references: TerminalRenameTarget[] = [
    { backend: "cmux", operation: "tab", target: "tab", id: "cmux-tab", scope: "surface" },
    { backend: "muxy", operation: "tab", target: "pane", id: "muxy-pane", scope: "surface" },
    { backend: "tmux", operation: "workspace", target: "session", id: "tmux-session", scope: "shared" },
    { backend: "zellij", operation: "tab", target: "pane", id: "zellij-pane", scope: "surface" },
    { backend: "wezterm", operation: "workspace", target: "window", id: "wezterm-pane", scope: "shared" },
    { backend: "herdr", operation: "tab", target: "pane", id: "herdr-pane", scope: "surface" },
    { backend: "otty", operation: "tab", target: "tab", id: "otty-tab", scope: "shared" },
  ];
  for (const reference of references) {
    assert.equal(renameTerminalTarget(reference, title, { run, renameOrca: () => true }).status, "renamed");
  }
  assert.deepEqual(calls, [
    ["cmux", ["rename-tab", "--surface", "cmux-tab", title]],
    ["muxy", ["rename-pane", "--pane", "muxy-pane", title]],
    ["tmux", ["rename-session", "-t", "tmux-session", title]],
    ["zellij", ["action", "rename-pane", title, "--pane-id", "zellij-pane"]],
    ["wezterm", ["cli", "set-window-title", "--pane-id", "wezterm-pane", title]],
    ["herdr", ["pane", "rename", "herdr-pane", title]],
    ["otty", ["tab", "rename", "--tab", "otty-tab", title]],
  ]);
});

test("Orca 失败由注入的后端报告，不触碰本机服务", () => {
  const result = renameTerminalTarget({ backend: "orca", operation: "tab", target: "terminal", id: "own", scope: "shared" }, "Task", {
    run: () => assert.fail("unexpected CLI"), renameOrca: () => false,
  });
  assert.equal(result.status, "failed");
});


test("tmux 在生成标题前解析固定 window/session ID", () => {
  const queries: string[][] = [];
  const results = resolveTerminalRenameTargets({ tab: true, workspace: true, backend: "tmux", env: {
    TMUX_PANE: "%child", PI_SUBAGENT_RENAME_TMUX_WINDOW: "1", PI_SUBAGENT_RENAME_TMUX_SESSION: "1",
  } }, (_command, args) => {
    queries.push(args);
    return args.at(-1) === "#{window_id}" ? "@own" : "$own";
  });
  assert.deepEqual(results.map((result) => result.status === "ready" && result.reference.id), ["$own", "@own"]);
  assert.ok(queries.every((args) => args.includes("%child")));
});
