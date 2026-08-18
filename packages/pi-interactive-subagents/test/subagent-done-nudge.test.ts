import assert from "node:assert/strict";
import test from "node:test";
import { shouldScheduleAgentEndNudge } from "../pi-extension/subagents/subagent-done.ts";

test("completion nudge runs after the agent stops normally", () => {
  assert.equal(
    shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "stop" }]),
    true,
  );
});

test("completion nudge ignores provider errors", () => {
  assert.equal(
    shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "error" }]),
    false,
  );
});

test("completion nudge ignores user aborts", () => {
  assert.equal(
    shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "aborted" }]),
    false,
  );
});

test("completion nudge ignores output-limit stops", () => {
  assert.equal(
    shouldScheduleAgentEndNudge([{ role: "assistant", stopReason: "length" }]),
    false,
  );
});
