import { test } from "node:test";
import assert from "node:assert/strict";
import {
  argumentValue,
  availableActions,
  completionValue,
  isArgumentAction,
  nextPhase,
  requiresPrepare,
  revisableArtifacts,
  type SpecActionKind,
} from "../src/actions.ts";
import type { Phase } from "../src/state.ts";

const kinds = (actions: ReturnType<typeof availableActions>): SpecActionKind[] =>
  actions.map((action) => action.kind);

test("批准后进入的下一阶段，complete 无后继", () => {
  assert.equal(nextPhase("requirements"), "design");
  assert.equal(nextPhase("design"), "tasks");
  assert.equal(nextPhase("tasks"), "implementation");
  assert.equal(nextPhase("implementation"), "verification");
  assert.equal(nextPhase("verification"), "complete");
  assert.equal(nextPhase("complete"), null);
});

test("可回退阶段不含尚未开始的 verification", () => {
  assert.deepEqual(revisableArtifacts("requirements"), ["requirements"]);
  assert.deepEqual(revisableArtifacts("design"), ["requirements", "design"]);
  assert.deepEqual(revisableArtifacts("tasks"), ["requirements", "design", "tasks"]);
  assert.deepEqual(revisableArtifacts("implementation"), ["requirements", "design", "tasks"]);
  assert.deepEqual(revisableArtifacts("verification"), [
    "requirements",
    "design",
    "tasks",
    "verification",
  ]);
  assert.deepEqual(revisableArtifacts("complete"), [
    "requirements",
    "design",
    "tasks",
    "verification",
  ]);
});

test("只有 use 与 revise 需要二级参数", () => {
  assert.equal(isArgumentAction("use"), true);
  assert.equal(isArgumentAction("revise"), true);
  assert.equal(isArgumentAction("status"), false);
  assert.equal(isArgumentAction(""), false);
  assert.equal(completionValue("use"), "use ");
  assert.equal(completionValue("revise"), "revise ");
  assert.equal(completionValue("stop"), "stop");
  assert.equal(argumentValue("use", "demo"), "use demo");
  assert.equal(argumentValue("revise", "tasks"), "revise tasks");
});

test("前置校验名单只覆盖需要核对磁盘状态的动作", () => {
  for (const kind of ["status", "approve", "revise", "continue"] as const) {
    assert.equal(requiresPrepare(kind), true, kind);
  }
  for (const kind of ["new", "use", "stop", "unknown"] as const) {
    assert.equal(requiresPrepare(kind), false, kind);
  }
});

test("未激活时提供新建，磁盘有规格才提供激活", () => {
  assert.deepEqual(
    kinds(availableActions({ blocked: false, active: null, hasSpecs: false })),
    ["new"],
  );
  assert.deepEqual(
    kinds(availableActions({ blocked: false, active: null, hasSpecs: true })),
    ["new", "use"],
  );
});

test("恢复失败时只给恢复与退出，不带旧授权动作", () => {
  assert.deepEqual(
    kinds(availableActions({ blocked: true, active: null, hasSpecs: false })),
    ["stop"],
  );
  assert.deepEqual(
    kinds(availableActions({ blocked: true, active: null, hasSpecs: true })),
    ["use", "stop"],
  );
});

test("待批时首项是批准，且不提供执行类动作", () => {
  const actions = availableActions({
    blocked: false,
    active: { phase: "tasks", status: "awaiting_approval" },
    hasSpecs: true,
  });
  assert.deepEqual(kinds(actions), ["approve", "status", "revise", "stop"]);
});

test("实现执行中首项是继续", () => {
  assert.deepEqual(
    kinds(availableActions({
      blocked: false,
      active: { phase: "implementation", status: "in_progress" },
      hasSpecs: true,
    })),
    ["continue", "status", "revise", "stop"],
  );
});

test("起草与完成阶段不给批准或继续", () => {
  for (const phase of ["requirements", "design", "tasks", "verification", "complete"] as Phase[]) {
    const status = phase === "complete" ? "done" : "drafting";
    const actions = kinds(availableActions({
      blocked: false,
      active: { phase, status },
      hasSpecs: true,
    }));
    assert.deepEqual(actions, ["status", "revise", "stop"], phase);
  }
});

test("每个动作只出现在对应状态下", () => {
  const drafting = kinds(availableActions({
    blocked: false,
    active: { phase: "design", status: "drafting" },
    hasSpecs: false,
  }));
  assert.ok(!drafting.includes("use"));
  assert.ok(!drafting.includes("approve"));
  assert.ok(!drafting.includes("continue"));
  assert.ok(drafting.includes("status"));
  assert.ok(drafting.includes("stop"));
});
