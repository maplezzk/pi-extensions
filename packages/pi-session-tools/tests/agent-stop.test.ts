import assert from "node:assert/strict";
import test from "node:test";
import { didAgentStopNormally } from "../src/session-tail-compaction-utils.ts";

test("normal model stop allows a context threshold reminder", () => {
  assert.equal(
    didAgentStopNormally([{ role: "assistant", stopReason: "stop" }]),
    true,
  );
});

test("provider error suppresses a context threshold reminder", () => {
  assert.equal(
    didAgentStopNormally([{ role: "assistant", stopReason: "error" }]),
    false,
  );
});

test("user abort suppresses a context threshold reminder", () => {
  assert.equal(
    didAgentStopNormally([{ role: "assistant", stopReason: "aborted" }]),
    false,
  );
});

test("output limit suppresses a context threshold reminder", () => {
  assert.equal(
    didAgentStopNormally([{ role: "assistant", stopReason: "length" }]),
    false,
  );
});
