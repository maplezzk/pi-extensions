import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import toolDisplayExtension from "pi-extensions-tool-display";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../../pi-extensions-tool-display/src/types.ts";
import distillExtension from "../index.ts";

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const PENDING_MIDDLEWARES_KEY = Symbol.for("pi-tool-display.pendingResultRenderMiddlewares.v1");
const PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");
/** distill 写兜底审计行的 entry 类型。 */
const DISTILL_AUDIT_ENTRY_TYPE = "pi-distill-audit";
/** 上下文里的界面模式；测试只需要一个非空值。 */
const UI_MODE_TUI = "tui";
/** 结果远小于阈值，测试因此不会调用提炼模型。 */
const MIN_CHARS_NEVER_SUMMARIZE = 1_000_000;
const BUILT_IN_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"];

interface HarnessEntry {
  type: string;
  data: unknown;
}

interface Harness {
  pi: unknown;
  entries: HarnessEntry[];
  /** 触发一个事件的全部处理器，返回最后一个非空返回值。 */
  emit(event: string, payload: unknown): Promise<unknown>;
  /** 按事件顺序跑一次 ffgrep 调用，返回 distill 处理后的工具结果。 */
  runFfgrepCall(): Promise<unknown>;
  /** distill 写下的兜底审计行。 */
  auditEntries(): HarnessEntry[];
}

/** 清掉共享协议上的宿主与等待队列，避免用例之间互相影响。 */
function resetToolDisplayProtocol(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[TOOL_DISPLAY_API_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[PENDING_MIDDLEWARES_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[PENDING_DECORATIONS_KEY];
}

/**
 * 建一个测试用扩展 API 桩。
 *
 * `ffgrep` 是第三方扩展注册的工具：自带 renderResult，且不在 tool-display 的内建覆盖
 * 名单里——正是 issue #187 里那类落到兜底 entry 的工具。
 */
function createHarness(): { harness: Harness; ffgrepTool: Record<string, unknown> } {
  const entries: HarnessEntry[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const ffgrepTool: Record<string, unknown> = {
    name: "ffgrep",
    description: "fuzzy grep",
    parameters: { type: "object", properties: { pattern: { type: "string" } } },
    // 工具自带的结果渲染：接线后它仍然是基线，只多挂一个审计面板。
    renderResult: () => new Text("ffgrep own output", 0, 0),
  };
  /** 按事件顺序调起全部处理器，返回最后一个非空返回值。 */
  const emit = async (event: string, payload: unknown): Promise<unknown> => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      mode: UI_MODE_TUI,
      ui: { theme, notify: () => undefined, confirm: async () => true, input: async () => undefined },
      signal: undefined,
    };
    let last: unknown;
    for (const handler of handlers.get(event) ?? []) {
      const returned = await handler(payload, ctx);
      if (returned !== undefined) {
        last = returned;
      }
    }
    return last;
  };
  const baseApi: Record<string, unknown> = {
    /** 记录事件处理器；一个事件可以有多个。 */
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    /** 本用例不需要注册过的工具本身。 */
    registerTool(): void {},
    /** 工具列表：内建工具桩 + 第三方 ffgrep。 */
    getAllTools(): unknown[] {
      return [
        ...BUILT_IN_TOOL_NAMES.map((name) => ({
          name,
          parameters: { type: "object", properties: {} },
          sourceInfo: { source: "builtin", path: `<builtin:${name}>` },
        })),
        ffgrepTool,
      ];
    },
    /** 内建工具都已激活，让 tool-display 的覆盖路径能跑起来。 */
    getActiveTools(): string[] {
      return [...BUILT_IN_TOOL_NAMES];
    },
    /** entry 渲染器只是被注册，本用例不渲染提示块。 */
    registerEntryRenderer(): void {},
    /** distill 的兜底审计行走这里，用例靠它断言。 */
    appendEntry(type: string, data: unknown): void {
      entries.push({ type, data });
    },
  };
  // 未显式提供的扩展 API 一律当空实现：本用例只关心工具结果这条路。
  const pi = new Proxy(baseApi, {
    get(target, property) {
      if (property in target) {
        return target[property as string];
      }
      return () => undefined;
    },
  });
  const harness: Harness = {
    pi,
    entries,
    emit,
    /** 跑一次 ffgrep 调用，拿到 distill 处理后的工具结果。 */
    async runFfgrepCall(): Promise<unknown> {
      const input = { pattern: "x", outputRequest: "summary" };
      await emit("tool_call", { toolCallId: "call_coverage", toolName: "ffgrep", input });
      return emit("tool_result", {
        toolCallId: "call_coverage",
        toolName: "ffgrep",
        input,
        content: [{ type: "text", text: "small ffgrep output" }],
        details: {},
        isError: false,
      });
    },
    /** distill 写下的兜底审计行。 */
    auditEntries(): HarnessEntry[] {
      return entries.filter((entry) => entry.type === DISTILL_AUDIT_ENTRY_TYPE);
    },
  };
  return { harness, ffgrepTool };
}

/** 渲染工具行，模拟 Pi 调用工具自己的 renderResult。 */
function renderToolRow(tool: Record<string, unknown>, result: unknown): string {
  const renderer = tool.renderResult as (
    result: unknown,
    options: unknown,
    theme: unknown,
    context: unknown,
  ) => { render(width: number): string[] };
  return renderer(
    result,
    { expanded: false, isPartial: false },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    { args: { pattern: "x" }, toolCallId: "call_coverage" },
  )
    .render(120)
    .join("\n");
}

/**
 * 在临时 agent 目录里跑一段用例，distill 的配置固定在「大阈值、不做提炼」上。
 */
async function withAgentDir(run: () => Promise<void>): Promise<void> {
  const agentDir = mkdtempSync(join(tmpdir(), "distill-coverage-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(join(agentDir, "extensions", "pi-distill"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "pi-distill", "config.json"),
    JSON.stringify({ enabled: true, minChars: MIN_CHARS_NEVER_SUMMARIZE, maxChars: MIN_CHARS_NEVER_SUMMARIZE }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetToolDisplayProtocol();
  try {
    await run();
  } finally {
    resetToolDisplayProtocol();
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("tool-display 宿主接管第三方工具后，distill 不再写兜底 entry，审计行进入工具行", async () => {
  await withAgentDir(async () => {
    const { harness, ffgrepTool } = createHarness();
    toolDisplayExtension(harness.pi as never, { config: DEFAULT_TOOL_DISPLAY_CONFIG });
    distillExtension(harness.pi as never);

    await harness.emit("session_start", { type: "session_start" });
    await harness.emit("before_agent_start", { prompt: "test", systemPrompt: "" });
    const result = await harness.runFfgrepCall();

    assert.equal(harness.auditEntries().length, 0, "审计行不应再落到独立 entry");
    const rendered = renderToolRow(ffgrepTool, result);
    assert.match(rendered, /Distill/);
    assert.match(rendered, /ffgrep own output/);
  });
});

test("没有 tool-display 宿主时，distill 仍用独立 entry 显示审计行", async () => {
  await withAgentDir(async () => {
    const { harness } = createHarness();
    distillExtension(harness.pi as never);

    await harness.emit("session_start", { type: "session_start" });
    await harness.runFfgrepCall();

    assert.equal(harness.auditEntries().length, 1);
  });
});
