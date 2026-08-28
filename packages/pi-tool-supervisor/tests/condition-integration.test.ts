import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { default as piSupervisorExtension } from "../src/index.ts";

const CONDITION_MODULE_TYPE = JSON.stringify({ type: "module" });

type TestHandler = (...args: unknown[]) => unknown;

/** Writes a condition module with an explicit ESM package boundary. */
async function createConditionModule(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-condition-integration-"));
  const path = join(directory, "condition.ts");
  await writeFile(join(directory, "package.json"), CONDITION_MODULE_TYPE, "utf8");
  await writeFile(path, source, "utf8");
  return path;
}

/** Creates a temporary supervisor configuration and returns its paths. */
async function createSupervisorConfig(
  condition: string,
): Promise<{ agentDir: string; rulePath: string }> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-agent-"));
  const rulePath = join(agentDir, "rules.md");
  await writeFile(rulePath, "# Tool rule\n\n1. Check the tool input.\n", "utf8");
  const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "config.json"), JSON.stringify({
    enabled: true,
    reviewers: [{
      name: "condition-reviewer",
      model: "condition-provider/model",
      rulesFile: rulePath,
      tools: ["custom-tool"],
      trigger: "before",
      condition,
    }],
  }), "utf8");
  return { agentDir, rulePath };
}

/** Creates a minimal native-shaped extension context for lifecycle tests. */
function createContext(
  cwd: string,
  modelRegistry: Record<string, unknown>,
): ExtensionContext {
  return { cwd, modelRegistry } as unknown as ExtensionContext;
}

/** Registers the supervisor against a handler-capturing Pi test double. */
function registerTestExtension(): Map<string, TestHandler> {
  const handlers = new Map<string, TestHandler>();
  const pi = {
    getAllTools: () => [],
    registerCommand: () => undefined,
    registerEntryRenderer: () => undefined,
    appendEntry: () => undefined,
    on: (event: string, handler: TestHandler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  piSupervisorExtension(pi);
  return handlers;
}

test("condition false 时不调用模型并允许 before 工具继续执行", async () => {
  const conditionPath = await createConditionModule("export default (event, ctx) => event.type === \"tool_call\" && ctx.cwd === \"/project\" && event.input.allow === true;\n");
  const { agentDir } = await createSupervisorConfig(conditionPath);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const faux = registerFauxProvider({ provider: "condition-provider", models: [{ id: "model" }] });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ passed: false, summary: "should not run", findings: [] }))]);
    const handlers = registerTestExtension();
    const context = createContext("/project", {
      find: () => { throw new Error("condition false must skip model lookup"); },
    });
    const input = { allow: false };
    const before = await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: "custom-tool",
      toolCallId: "condition-skip",
      input,
    }, context);
    assert.equal(before, undefined);

    const result = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "custom-tool",
      toolCallId: "condition-skip",
      input,
      content: [{ type: "text", text: "ok" }],
      details: {},
      isError: false,
    }, context) as { details: { fileEditReview: { reviewers: Array<{ status: string }> } } };
    assert.deepEqual(result.details.fileEditReview.reviewers.map((reviewer) => reviewer.status), ["skipped"]);
    assert.equal(faux.state.callCount, 0);
    await handlers.get("session_shutdown")?.();
  } finally {
    faux.unregister();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("condition true 时将原生 event/context 交给 reviewer，before rejected 会阻断工具", async () => {
  const conditionPath = await createConditionModule("export default (event, ctx, helpers) => event.type === \"tool_call\" && event.toolName === \"custom-tool\" && event.input.allow === true && ctx.cwd === \"/project\" && helpers.parseBash(\"echo ok\").commands.length === 1;\n");
  const { agentDir } = await createSupervisorConfig(conditionPath);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const faux = registerFauxProvider({ provider: "condition-provider", models: [{ id: "model" }] });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    faux.setResponses([fauxAssistantMessage(JSON.stringify({
      passed: false,
      summary: "输入不符合条件规则",
      findings: [{ message: "禁止执行该工具" }],
    }))]);
    const handlers = registerTestExtension();
    const context = createContext("/project", {
      find: () => faux.getModel(),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, env: {} }),
    });
    const block = await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: "custom-tool",
      toolCallId: "condition-block",
      input: { allow: true },
    }, context) as { block?: boolean; reason?: string };

    assert.equal(block.block, true);
    assert.match(block.reason ?? "", /输入不符合条件规则/);
    assert.equal(faux.state.callCount, 1);
    await handlers.get("session_shutdown")?.();
  } finally {
    faux.unregister();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("condition 模块加载失败时 before 会阻断工具且不调用模型", async () => {
  const { agentDir } = await createSupervisorConfig("missing-condition.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handlers = registerTestExtension();
    const context = createContext("/project", {
      find: () => { throw new Error("condition failure must block before model lookup"); },
    });
    const block = await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: "custom-tool",
      toolCallId: "condition-error",
      input: { allow: true },
    }, context) as { block?: boolean; reason?: string };

    assert.equal(block.block, true);
    assert.match(block.reason ?? "", /条件模块|Condition module/);
    await handlers.get("session_shutdown")?.();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("condition module 可以在 after 阶段读取原生 tool_result event", async () => {
  const conditionPath = await createConditionModule("export default (event, ctx) => event.type === \"tool_result\" && event.toolName === \"custom-tool\" && event.input.value === 2 && event.isError === false && ctx.cwd === \"/project\";\n");
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-agent-after-"));
  const rulePath = join(agentDir, "rules.md");
  await writeFile(rulePath, "# Tool rule\n", "utf8");
  const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(configDirectory, "config.json"), JSON.stringify({
    enabled: true,
    reviewers: [{
      name: "after-condition-reviewer",
      model: "condition-provider/model",
      rulesFile: rulePath,
      tools: ["custom-tool"],
      trigger: "after",
      condition: conditionPath,
    }],
  }), "utf8");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const faux = registerFauxProvider({ provider: "condition-provider", models: [{ id: "model" }] });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ passed: true, summary: "ok", findings: [] }))]);
    const handlers = registerTestExtension();
    const context = createContext("/project", {
      find: () => faux.getModel(),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, env: {} }),
    });
    const input = { value: 2 };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: "custom-tool",
      toolCallId: "condition-after",
      input,
    }, context);
    const result = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "custom-tool",
      toolCallId: "condition-after",
      input,
      content: [{ type: "text", text: "ok" }],
      details: {},
      isError: false,
    }, context) as { details: { fileEditReview: { status: string } } };

    assert.equal(result.details.fileEditReview.status, "passed");
    assert.equal(faux.state.callCount, 1);
    await handlers.get("session_shutdown")?.();
  } finally {
    faux.unregister();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
