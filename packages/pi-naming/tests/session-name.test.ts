import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionNamePrompt,
  getSessionUserMessages,
  normalizeSessionName,
  requestSessionName,
  requestSessionNameWithTimeout,
  registerAutomaticSessionNaming,
  type SessionNameCompletion,
  type SessionNameRequest,
  type SessionNameRequester,
} from "../src/session-name.ts";

type InputEvent = {
  type?: string;
  text?: string;
  source?: string;
};

type RegisteredHandler = (event: InputEvent, ctx: ExtensionContext) => unknown;

/** 构造最小化的用户消息 session 条目，供提取逻辑测试使用。 */
function userEntry(id: string, content: unknown): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "user",
      content,
      timestamp: 0,
    },
  } as SessionEntry;
}

test("getSessionUserMessages 只提取用户消息中的文本", () => {
  const entries = [
    userEntry("user-1", "实现自动命名"),
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "好的" }],
      },
    },
    userEntry("user-2", [
      { type: "text", text: "补充" },
      { type: "image", data: "ignored" },
      { type: "text", text: "测试要求" },
    ]),
  ] as SessionEntry[];

  assert.deepEqual(getSessionUserMessages(entries), ["实现自动命名", "补充测试要求"]);
});

test("buildSessionNamePrompt 为用户消息添加边界", () => {
  const prompt = buildSessionNamePrompt(["修复登录超时", "补充回归测试"]);

  assert.match(prompt, /<user-messages>/);
  assert.match(prompt, /<user-message index="1">\n修复登录超时/);
  assert.match(prompt, /<user-message index="2">\n补充回归测试/);
  assert.match(prompt, /<\/user-messages>/);
});

test("normalizeSessionName 收敛模型的标题格式并限制长度", () => {
  assert.equal(normalizeSessionName('```text\n"修复登录超时"\n```'), "修复登录超时");
  assert.equal(normalizeSessionName("标题：  Fix timeout\n补充说明"), "Fix timeout");
  assert.equal(normalizeSessionName("- Add tests"), "Add tests");
  assert.equal(normalizeSessionName("12345678901234567890"), "123456789012345");
});

test("requestSessionName 使用当前模型和鉴权信息单独请求标题", async () => {
  let receivedPrompt = "";
  let receivedApiKey = "";
  /** 返回固定标题并记录请求参数的 completion 测试替身。 */
  const completion: SessionNameCompletion = async (_model, context, options) => {
    receivedPrompt = context.messages[0]?.content instanceof Array
      ? context.messages[0].content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("")
      : "";
    receivedApiKey = options?.apiKey ?? "";
    return {
      role: "assistant",
      content: [{ type: "text", text: '"修复登录超时"' }],
      api: "test-api",
      provider: "test-provider",
      model: "title-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
  };
  const ctx = {
    model: { provider: "test-provider", id: "title-model" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: "test-key",
        headers: { "x-test": "1" },
        env: {},
      }),
    },
  } as unknown as SessionNameRequest["ctx"];

  const name = await requestSessionName({
    userMessages: ["修复登录超时"],
    ctx,
    completion,
  });

  assert.equal(name, "修复登录超时");
  assert.match(receivedPrompt, /修复登录超时/);
  assert.equal(receivedApiKey, "test-key");
});

test("requestSessionName 显式报告鉴权、模型和空标题错误", async () => {
  const noModelContext = {
    model: undefined,
    modelRegistry: {},
  } as unknown as SessionNameRequest["ctx"];
  await assert.rejects(
    requestSessionName({ userMessages: ["任务"], ctx: noModelContext }),
    /No model|没有可用模型/,
  );

  const authContext = {
    model: { provider: "test-provider", id: "title-model" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: "missing auth" }),
    },
  } as unknown as SessionNameRequest["ctx"];
  await assert.rejects(
    requestSessionName({ userMessages: ["任务"], ctx: authContext }),
    /authentication|鉴权/,
  );

  const emptyCompletion: SessionNameCompletion = async () => ({
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "title-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  });
  const validContext = {
    model: { provider: "test-provider", id: "title-model" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    },
  } as unknown as SessionNameRequest["ctx"];
  await assert.rejects(
    requestSessionName({ userMessages: ["任务"], ctx: validContext, completion: emptyCompletion }),
    /valid title|有效标题/,
  );
});

test("requestSessionNameWithTimeout 超时后中止请求", async () => {
  let signal: AbortSignal | undefined;
  const requestName: SessionNameRequester = async (request) => {
    signal = request.signal;
    return new Promise<string>(() => undefined);
  };
  const ctx = {} as SessionNameRequest["ctx"];

  await assert.rejects(
    requestSessionNameWithTimeout({
      userMessages: ["超时任务"],
      ctx,
      requestName,
      timeoutMs: 5,
    }),
    /timed out|超时/,
  );
  assert.equal(signal?.aborted, true);
});

test("registerAutomaticSessionNaming 只在新 session 首条真实输入后命名一次", async () => {
  let sessionName: string | undefined;
  const notices: string[] = [];
  const handlers = new Map<string, RegisteredHandler>();
  const sessionManager = {
    getBranch: () => [],
    getSessionName: () => sessionName,
  };
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager,
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: RegisteredHandler) => handlers.set(event, handler),
    getSessionName: () => sessionName,
    setSessionName: (name: string) => {
      sessionName = name;
    },
  } as unknown as ExtensionAPI;
  const requestedMessages: string[][] = [];

  registerAutomaticSessionNaming(pi, async ({ userMessages }) => {
    requestedMessages.push([...userMessages]);
    return "自动生成的标题";
  });

  handlers.get("session_start")?.({ type: "session_start" }, ctx);
  handlers.get("input")?.({
    type: "input",
    text: "实现首条消息自动命名",
    source: "interactive",
  }, ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  handlers.get("input")?.({
    type: "input",
    text: "第二条消息不应再次命名",
    source: "interactive",
  }, ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(requestedMessages, [["实现首条消息自动命名"]]);
  assert.equal(sessionName, "自动生成的标题");
  assert.equal(notices.length, 1);
});

test("已有手动名称、空输入和 extension 输入不会触发自动命名", async () => {
  let sessionName: string | undefined = "手动名称";
  let requestCount = 0;
  const handlers = new Map<string, RegisteredHandler>();
  const sessionManager = {
    getBranch: () => [],
    getSessionName: () => sessionName,
  };
  const ctx = { hasUI: false, ui: { notify: () => undefined }, sessionManager } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: RegisteredHandler) => handlers.set(event, handler),
    getSessionName: () => sessionName,
    setSessionName: (name: string) => {
      sessionName = name;
    },
  } as unknown as ExtensionAPI;

  registerAutomaticSessionNaming(pi, async () => {
    requestCount += 1;
    return "不应出现";
  });
  handlers.get("session_start")?.({}, ctx);
  handlers.get("input")?.({ text: "手动名称不能覆盖", source: "interactive" }, ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 0);

  sessionName = undefined;
  handlers.get("session_start")?.({}, ctx);
  handlers.get("input")?.({ text: "   ", source: "interactive" }, ctx);
  handlers.get("input")?.({ text: "扩展消息", source: "extension" }, ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 0);
});

test("session 切换后丢弃过期命名结果", async () => {
  let sessionName: string | undefined;
  let resolveName: (name: string) => void = () => undefined;
  const pendingName = new Promise<string>((resolve) => {
    resolveName = resolve;
  });
  const handlers = new Map<string, RegisteredHandler>();
  const sessionManager = { getBranch: () => [], getSessionName: () => sessionName };
  const ctx = { hasUI: false, ui: { notify: () => undefined }, sessionManager } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: RegisteredHandler) => handlers.set(event, handler),
    getSessionName: () => sessionName,
    setSessionName: (name: string) => {
      sessionName = name;
    },
  } as unknown as ExtensionAPI;

  registerAutomaticSessionNaming(pi, async () => pendingName);
  handlers.get("session_start")?.({}, ctx);
  handlers.get("input")?.({ text: "旧 session 的首条消息", source: "interactive" }, ctx);
  handlers.get("session_start")?.({}, ctx);
  resolveName("旧 session 标题");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(sessionName, undefined);
});

test("旧实例 shutdown 后即使没有再次收到 start 也不得写入标题", async () => {
  const handlers = new Map<string, RegisteredHandler>();
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const pi = {
    on: (name: string, handler: RegisteredHandler) => handlers.set(name, handler),
    getSessionName: () => undefined,
    setSessionName: () => assert.fail("旧实例不能写入 session"),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: { notify: () => assert.fail("旧实例不能发送通知") },
    sessionManager: { getBranch: () => [], getSessionName: () => undefined },
  } as unknown as ExtensionContext;
  registerAutomaticSessionNaming(pi, async () => pending);
  handlers.get("session_start")!({}, ctx);
  handlers.get("input")!({ text: "任务", source: "interactive" }, ctx);
  handlers.get("session_shutdown")!({}, ctx);
  finish("过期标题");
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("标题按 Unicode 字符截断，不切断代理对", () => {
  assert.equal(normalizeSessionName("😀".repeat(16)), "😀".repeat(15));
});
