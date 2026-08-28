import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  CONDITION_ERROR_STATUS,
  CONDITION_MATCHED_STATUS,
  CONDITION_NOT_MATCHED_STATUS,
  evaluateToolCondition,
} from "../src/condition-utils.ts";

const CONDITION_TIMEOUT_MS = 100;
const CONDITION_TIMEOUT_TEST_MS = 5;

/** Writes an isolated condition module and returns its absolute path. */
async function createConditionModule(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-condition-"));
  const path = join(directory, "condition.ts");
  await writeFile(path, source, "utf8");
  return path;
}

/** Creates the smallest context shape required by a condition module test. */
function createContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

/** Creates a native-shaped tool call event for direct condition evaluation. */
function createToolCall(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "condition-test",
    toolName: "bash",
    input: { command },
  } as ToolCallEvent;
}

test("没有配置 condition 时默认匹配", async () => {
  const evaluation = await evaluateToolCondition({
    cwd: "/project",
    event: createToolCall("echo ok"),
    ctx: createContext("/project"),
    timeoutMs: CONDITION_TIMEOUT_MS,
  });

  assert.equal(evaluation.status, CONDITION_MATCHED_STATUS);
  assert.equal(evaluation.durationMs, 0);
});

test("condition module 接收原生 event、ExtensionContext 和 Bash helper", async () => {
  const conditionPath = await createConditionModule(`
export default (event, ctx, helpers) =>
  event.toolName === "bash" &&
  event.input.command === "mvn test" &&
  ctx.cwd === "/project" &&
  helpers.parseBash(event.input.command).commands.length === 1;
`);

  const evaluation = await evaluateToolCondition({
    conditionPath,
    cwd: "/project",
    event: createToolCall("mvn test"),
    ctx: createContext("/project"),
    timeoutMs: CONDITION_TIMEOUT_MS,
  });

  assert.equal(evaluation.status, CONDITION_MATCHED_STATUS);
  assert.equal(evaluation.path, conditionPath);
});

test("condition 返回 false 时跳过 reviewer", async () => {
  const conditionPath = await createConditionModule("export default () => false;\n");
  const evaluation = await evaluateToolCondition({
    conditionPath,
    cwd: "/project",
    event: createToolCall("echo ok"),
    ctx: createContext("/project"),
    timeoutMs: CONDITION_TIMEOUT_MS,
  });

  assert.equal(evaluation.status, CONDITION_NOT_MATCHED_STATUS);
  assert.equal(evaluation.error, undefined);
});

test("condition module 文件变化后按指纹重新加载", async () => {
  const conditionPath = await createConditionModule("export default () => false;\n");
  const options = {
    conditionPath,
    cwd: "/project",
    event: createToolCall("echo ok"),
    ctx: createContext("/project"),
    timeoutMs: CONDITION_TIMEOUT_MS,
  };
  const first = await evaluateToolCondition(options);
  await writeFile(conditionPath, "export default () => true;\n", "utf8");
  const second = await evaluateToolCondition(options);

  assert.equal(first.status, CONDITION_NOT_MATCHED_STATUS);
  assert.equal(second.status, CONDITION_MATCHED_STATUS);
});

test("condition module 非 boolean 返回值会形成显式错误", async () => {
  const conditionPath = await createConditionModule("export default () => \"yes\";\n");
  const evaluation = await evaluateToolCondition({
    conditionPath,
    cwd: "/project",
    event: createToolCall("echo ok"),
    ctx: createContext("/project"),
    timeoutMs: CONDITION_TIMEOUT_MS,
  });

  assert.equal(evaluation.status, CONDITION_ERROR_STATUS);
  assert.match(evaluation.error ?? "", /boolean/);
});

test("condition module 超时会形成显式错误", async () => {
  const conditionPath = await createConditionModule("export default () => new Promise(() => {});\n");
  const evaluation = await evaluateToolCondition({
    conditionPath,
    cwd: "/project",
    event: createToolCall("echo ok"),
    ctx: createContext("/project"),
    timeoutMs: CONDITION_TIMEOUT_TEST_MS,
  });

  assert.equal(evaluation.status, CONDITION_ERROR_STATUS);
  assert.match(evaluation.error ?? "", /timed out/);
});
