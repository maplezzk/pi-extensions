import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  registerTerminalRename,
  type RenameDependencies,
} from "../src/terminal-rename.ts";
import type {
  RenameCapability,
  RenameResult,
} from "pi-terminal-mux";

/** 构造测试用的最小 Extension API，保留命令处理器供测试调用。 */
function createPiMock() {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const events = new Map<string, () => void>();
  let sessionName: string | undefined;
  const pi = {
    on: (name: string, handler: () => void) => events.set(name, handler),
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      commands.set(name, command);
    },
    setSessionName(name: string) {
      sessionName = name;
    },
    getSessionName() {
      return sessionName;
    },
  } as unknown as ExtensionAPI;
  return { pi, commands, events, getSessionName: () => sessionName };
}

function createContext(userMessages: string[] = []) {
  const notifications: string[] = [];
  const context = {
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: {
      getBranch: () => userMessages.map((content, index) => ({
        type: "message",
        id: `user-${index}`,
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content },
      })),
    },
    model: { provider: "test", id: "model" },
    modelRegistry: {},
  } as unknown as ExtensionContext & ExtensionCommandContext;
  return { context, notifications };
}

function dependencies(
  capability: RenameCapability,
  result: RenameResult,
): RenameDependencies {
  return {
    getBackend: () => capability.status === "unsupported" ? null : capability.backend,
    getCapability: () => capability,
    renameCurrentTab: () => result,
    renameWorkspace: () => result,
  };
}

test("workspace 显式名称仅在终端重命名成功后同步 Pi session", async () => {
  const { pi, commands, getSessionName } = createPiMock();
  const { context, notifications } = createContext();
  registerTerminalRename(
    pi,
    async () => "不会使用",
    dependencies(
      { status: "supported", backend: "cmux", operation: "workspace", target: "workspace" },
      { status: "renamed", backend: "cmux", operation: "workspace", target: "workspace" },
    ),
  );

  await commands.get("rename:workspace")!.handler("项目标题", context);

  assert.equal(getSessionName(), "项目标题");
  assert.match(notifications[0]!, /项目标题/);
});

test("workspace 失败时不修改 Pi session 名称", async () => {
  const { pi, commands, getSessionName } = createPiMock();
  const { context, notifications } = createContext();
  registerTerminalRename(
    pi,
    async () => "不会使用",
    dependencies(
      { status: "supported", backend: "cmux", operation: "workspace", target: "workspace" },
      { status: "failed", backend: "cmux", operation: "workspace", target: "workspace", error: "command failed" },
    ),
  );

  await commands.get("rename:workspace")!.handler("项目标题", context);

  assert.equal(getSessionName(), undefined);
  assert.match(notifications[0]!, /失败|failed/i);
});

test("workspace 无参数使用独立标题生成器，tab 不触发标题生成", async () => {
  const { pi, commands, getSessionName } = createPiMock();
  const workspace = createContext(["修复登录超时"]);
  let requests = 0;
  registerTerminalRename(
    pi,
    async ({ userMessages }) => {
      requests += 1;
      assert.deepEqual(userMessages, ["修复登录超时"]);
      return "自动标题";
    },
    dependencies(
      { status: "supported", backend: "cmux", operation: "workspace", target: "workspace" },
      { status: "renamed", backend: "cmux", operation: "workspace", target: "workspace" },
    ),
  );

  await commands.get("rename:workspace")!.handler("", workspace.context);
  assert.equal(requests, 1);
  assert.equal(getSessionName(), "自动标题");
});

test("unsupported 和 disabled 都不伪报成功", async () => {
  for (const capability of [
    { status: "unsupported", backend: "headless", operation: "workspace" },
    { status: "disabled", backend: "tmux", operation: "workspace", setting: "PI_SUBAGENT_RENAME_TMUX_SESSION" },
  ] as RenameCapability[]) {
    const { pi, commands, getSessionName } = createPiMock();
    const { context, notifications } = createContext();
    registerTerminalRename(pi, async () => "不会使用", dependencies(capability, capability as never));
    await commands.get("rename:workspace")!.handler("项目标题", context);
    assert.equal(getSessionName(), undefined);
    assert.match(notifications[0]!, /支持|关闭|support|disabled/i);
  }
});

for (const event of ["session_start", "session_shutdown"]) {
  for (const rejects of [false, true]) {
    test(`等待标题时 ${event} 后丢弃旧${rejects ? "错误" : "结果"}`, async () => {
      const mock = createPiMock();
      const { context, notifications } = createContext(["旧会话任务"]);
      let finish!: (value: string) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
      const deps = dependencies(
        { status: "supported", backend: "cmux", operation: "workspace", target: "workspace" },
        { status: "renamed", backend: "cmux", operation: "workspace", target: "workspace" },
      );
      deps.renameWorkspace = () => assert.fail("旧请求不能修改终端");
      registerTerminalRename(mock.pi, async () => pending, deps);
      const running = mock.commands.get("rename:workspace")!.handler("", context);
      mock.events.get(event)!();
      if (rejects) fail(new Error("stale request")); else finish("旧标题");
      await running;
      assert.equal(mock.getSessionName(), undefined);
      assert.deepEqual(notifications, []);
    });
  }
}

test("后续手动改名优先，旧模型结果不能覆盖", async () => {
  const mock = createPiMock();
  const { context } = createContext(["任务"]);
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const labels: string[] = [];
  const result: RenameResult = { status: "renamed", backend: "cmux", operation: "workspace", target: "workspace" };
  const deps = dependencies({ status: "supported", backend: "cmux", operation: "workspace", target: "workspace" }, result);
  deps.renameWorkspace = (label) => { labels.push(label); return result; };
  registerTerminalRename(mock.pi, async () => pending, deps);
  const handler = mock.commands.get("rename:workspace")!.handler;
  const running = handler("", context);
  await handler("手动标题", context);
  finish("旧标题");
  await running;
  assert.deepEqual(labels, ["手动标题"]);
  assert.equal(mock.getSessionName(), "手动标题");
});
