import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SubagentWorkflowAgent } from "../src/subagent-agent.ts";

/**
 * Build a fake __pi_subagents bridge that records launch params and returns a
 * valid session file, so SubagentWorkflowAgent.run() reaches its result handling.
 */
function withFakeSubagentApi(
  run: (
    launched: Array<Record<string, unknown>>,
    launchOptions: Array<Record<string, unknown> | undefined>,
  ) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-agent-test-"));
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "{}\n");

  const launched: Array<Record<string, unknown>> = [];
  const launchOptions: Array<Record<string, unknown> | undefined> = [];
  const previous = (globalThis as { __pi_subagents?: unknown }).__pi_subagents;
  (globalThis as { __pi_subagents?: unknown }).__pi_subagents = {
    /** Record launch params and hand back a session file that exists and is non-empty. */
    async launchSubagent(params: Record<string, unknown>, _ctx: unknown, options?: Record<string, unknown>) {
      launched.push(params);
      launchOptions.push(options);
      return { id: "test", name: params.name as string, surface: "test", sessionFile, startTime: Date.now() };
    },
    /**
     * Report a completed child run whose validated structured output is the agent() result.
     */
    async watchSubagent() {
      return {
        name: "test",
        task: "test",
        summary: "done",
        exitCode: 0,
        elapsed: 1,
        structuredOutput: { ok: true },
      };
    },
  };

  return run(launched, launchOptions).finally(() => {
    (globalThis as { __pi_subagents?: unknown }).__pi_subagents = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

function createAgent() {
  /** Minimal launch context: no ui, so notices are skipped. */
  return new SubagentWorkflowAgent({ cwd: process.cwd(), launchCtx: {} as never });
}

test("agent() with a schema denies caller_ping in the child session", async () => {
  await withFakeSubagentApi(async (launched) => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const result = await createAgent().run("implement the task", { label: "impl", schema });

    assert.deepEqual(result, { ok: true });
    assert.equal(launched.length, 1, "one child session should be launched");
    assert.deepEqual(launched[0].structuredOutputSchema, schema);
    assert.equal(
      launched[0].denyTools,
      "caller_ping",
      "a child that must return structured output cannot exit through a help request",
    );
  });
});

test("agent() without a schema keeps caller_ping available", async () => {
  await withFakeSubagentApi(async (launched) => {
    await createAgent().run("summarize the diff", { label: "summary" });

    assert.equal(launched.length, 1);
    assert.equal(launched[0].denyTools, undefined, "no structured result means the ping exit is not fatal");
    assert.equal(launched[0].structuredOutputSchema, undefined);
  });
});

test("workflow agents are hidden from the Subagents widget", async () => {
  await withFakeSubagentApi(async (launched, launchOptions) => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await createAgent().run("review the module", { label: "review", schema });

    assert.equal(launched.length, 1);
    assert.deepEqual(
      launchOptions[0],
      { hiddenFromWidget: true },
      "workflow renders its own agent panel, so the Subagents widget must not repeat these agents",
    );
  });
});
