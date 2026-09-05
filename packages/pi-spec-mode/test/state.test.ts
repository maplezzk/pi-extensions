import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createState,
  transition,
  parseStatusKey,
  computeWriteArtifact,
  invalidateIfStale,
  type StateFile,
} from "../src/state.ts";

const sha = (s: string) => `sha256:${s}`;

function run(state: StateFile, event: Parameters<typeof transition>[1]) {
  const result = transition(state, event);
  if (!result.ok) throw new Error(result.error);
  return result.state;
}

describe("状态机基础", () => {
  test("createState 初始为 requirements.drafting，严格模式", () => {
    const s = createState("oauth-login", "OAuth 登录", "strict");
    assert.equal(parseStatusKey(s), "requirements.drafting");
    assert.equal(s.profile, "strict");
    assert.equal(s.revision, 1);
  });

  test("quick 模式写入 profile 字段", () => {
    const s = createState("x", "x", "quick");
    assert.equal(s.profile, "quick");
  });

  test("非法转换：未提交就批准", () => {
    const s = createState("x", "x", "strict");
    const r = transition(s, { type: "approve" });
    assert.equal(r.ok, false);
  });

  test("非法转换：drafting 提交两次", () => {
    const s = run(createState("x", "x", "strict"), { type: "submit", sha256: sha("a") });
    const r = transition(s, { type: "submit", sha256: sha("b") });
    assert.equal(r.ok, false);
  });
});

describe("strict 完整链路", () => {
  test("requirements 全流程：提交→批准→design", () => {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r1") });
    assert.equal(parseStatusKey(s), "requirements.awaiting_approval");
    s = run(s, { type: "approve" });
    assert.equal(parseStatusKey(s), "design.drafting");
    assert.equal(s.artifacts.requirements.approvedSha256, sha("r1"));
    assert.equal(s.artifacts.requirements.approvalKind, "human");
  });

  test("design 提交到 tasks，tasks 批准进入实现执行", () => {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("d") });
    s = run(s, { type: "approve" });
    assert.equal(parseStatusKey(s), "tasks.drafting");
    s = run(s, { type: "submit", sha256: sha("t") });
    s = run(s, { type: "approve" });
    assert.equal(parseStatusKey(s), "implementation.in_progress");
  });

  test("实现完成后进入验证，验证批准后 complete", () => {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("d") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("t") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "all_tasks_done" });
    assert.equal(parseStatusKey(s), "verification.drafting");
    s = run(s, { type: "submit", sha256: sha("v") });
    assert.equal(parseStatusKey(s), "verification.awaiting_approval");
    s = run(s, { type: "approve" });
    assert.equal(parseStatusKey(s), "complete.done");
  });
});

describe("quick 模式", () => {
  test("需求提交直接进入 design（accepted-by-profile）", () => {
    let s = createState("x", "x", "quick");
    s = run(s, { type: "submit", sha256: sha("r") });
    assert.equal(parseStatusKey(s), "design.drafting");
    assert.equal(s.artifacts.requirements.approvalKind, "accepted-by-profile");
  });

  test("设计提交直接进入 tasks", () => {
    let s = createState("x", "x", "quick");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "submit", sha256: sha("d") });
    assert.equal(parseStatusKey(s), "tasks.drafting");
  });

  test("tasks 仍必须人类批准才能执行", () => {
    let s = createState("x", "x", "quick");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "submit", sha256: sha("d") });
    s = run(s, { type: "submit", sha256: sha("t") });
    assert.equal(parseStatusKey(s), "tasks.awaiting_approval");
    s = run(s, { type: "approve" });
    assert.equal(s.artifacts.tasks.approvalKind, "human");
    assert.equal(parseStatusKey(s), "implementation.in_progress");
  });
});

describe("revise 回退", () => {
  function approvedChain(): StateFile {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("d") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("t") });
    s = run(s, { type: "approve" });
    return s; // implementation.in_progress
  }

  test("回退 requirements 清空下游全部批准", () => {
    const s = run(approvedChain(), { type: "revise", artifact: "requirements" });
    assert.equal(parseStatusKey(s), "requirements.drafting");
    assert.equal(s.artifacts.requirements.approvedSha256, undefined);
    assert.equal(s.artifacts.design.approvedSha256, undefined);
    assert.equal(s.artifacts.tasks.approvedSha256, undefined);
  });

  test("回退 design 保留 requirements、清空 design 及以下", () => {
    const s = run(approvedChain(), { type: "revise", artifact: "design" });
    assert.equal(parseStatusKey(s), "design.drafting");
    assert.equal(s.artifacts.requirements.approvedSha256, sha("r"));
    assert.equal(s.artifacts.design.approvedSha256, undefined);
    assert.equal(s.artifacts.tasks.approvedSha256, undefined);
  });

  test("不能回退未开始的阶段", () => {
    const s = createState("x", "x", "strict");
    const r = transition(s, { type: "revise", artifact: "tasks" });
    assert.equal(r.ok, false);
  });
});

describe("写入门禁", () => {
  test("drafting 阶段返回对应文档，awaiting 拒绝", () => {
    let s = createState("x", "x", "strict");
    assert.equal(computeWriteArtifact(s), "requirements");
    s = run(s, { type: "submit", sha256: sha("r") });
    assert.equal(computeWriteArtifact(s), null);
  });

  test("执行阶段允许 tasks.md，完成阶段禁止", () => {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("d") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("t") });
    s = run(s, { type: "approve" });
    assert.equal(computeWriteArtifact(s), "tasks");
    s = run(s, { type: "all_tasks_done" });
    assert.equal(computeWriteArtifact(s), "verification");
  });
});

describe("哈希失效级联", () => {
  test("requirements 变更使全部下游失效并回退", () => {
    const base = run(
      run(
        run(
          run(createState("x", "x", "strict"), { type: "submit", sha256: sha("r") }),
          { type: "approve" },
        ),
        { type: "submit", sha256: sha("d") },
      ),
      { type: "approve" },
    );
    const s = invalidateIfStale(base, {
      requirements: sha("r-changed"),
      design: sha("d"),
      tasks: null,
      verification: null,
    });
    assert.notEqual(s, null);
    assert.equal(parseStatusKey(s!), "requirements.drafting");
    assert.equal(s!.artifacts.design.approvedSha256, undefined);
  });

  test("哈希一致不变化", () => {
    const base = run(
      run(createState("x", "x", "strict"), { type: "submit", sha256: sha("r") }),
      { type: "approve" },
    );
    const s = invalidateIfStale(base, {
      requirements: sha("r"),
      design: null,
      tasks: null,
      verification: null,
    });
    assert.equal(s, null);
  });

  test("task_done 更新 activeTask", () => {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("d") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("t") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "task_done", taskId: "TASK-1" });
    assert.equal(s.activeTask, "TASK-1");
    assert.deepEqual(s.completedTasks, ["TASK-1"]);
  });

  test("重复 task_done 不重复记录", () => {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("d") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("t") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "task_done", taskId: "TASK-1" });
    s = run(s, { type: "task_done", taskId: "TASK-1" });
    assert.deepEqual(s.completedTasks, ["TASK-1"]);
  });

  test("design 变更在 requirements 一致时仍会失效", () => {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "approve" });
    s = run(s, { type: "submit", sha256: sha("d") });
    s = run(s, { type: "approve" });
    const invalidated = invalidateIfStale(s, {
      requirements: sha("r"),
      design: sha("d-changed"),
      tasks: null,
      verification: null,
    });
    assert.notEqual(invalidated, null);
    assert.equal(parseStatusKey(invalidated!), "design.drafting");
    assert.equal(invalidated!.artifacts.requirements.approvedSha256, sha("r"));
  });

  test("已批准文件被删除也会失效", () => {
    let s = createState("x", "x", "strict");
    s = run(s, { type: "submit", sha256: sha("r") });
    s = run(s, { type: "approve" });
    const invalidated = invalidateIfStale(s, {
      requirements: null,
      design: null,
      tasks: null,
      verification: null,
    });
    assert.notEqual(invalidated, null);
    assert.equal(parseStatusKey(invalidated!), "requirements.drafting");
  });
});
