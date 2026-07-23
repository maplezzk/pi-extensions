import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  renderWorkflowText,
  renderWorkflowWidgetLines,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "../src/display.ts";

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return recomputeWorkflowSnapshot({
    name: "demo_workflow",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    ...overrides,
  });
}

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
  return {
    id: 1,
    label: "scan repo",
    phase: "Scan",
    prompt: "Scan the repo",
    status: "done",
    ...overrides,
  };
}

test("createWorkflowSnapshot does not pre-render declared phases", () => {
  const value = createWorkflowSnapshot({
    name: "demo_workflow",
    description: "A useful workflow",
    phases: [{ title: "Scan" }, { title: "Review" }],
  });

  assert.deepEqual(value.phases, ["Scan", "Review"]);
});

test("renderWorkflowLines hides empty phase rows", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan", "Review"],
      agents: [agent()],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Scan 1/1")));
  assert.ok(!lines.some((line) => line.includes("Review 0/0")));
});

test("renderWorkflowLines keeps the current empty phase visible", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      currentPhase: "Scan",
    }),
  );

  assert.ok(lines.some((line) => line.includes("▶ Scan 0/0")));
});

test("renderWorkflowLines groups agents by phase even when the phase was not pre-recorded", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Scan"],
      agents: [agent({ id: 2, label: "review diff", phase: "Review" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Review 1/1")));
  assert.ok(!lines.some((line) => line.trim() === "Unphased"));
});

test("renderWorkflowLines renders runtime-created phases from the phase list", () => {
  const lines = renderWorkflowLines(
    snapshot({
      phases: ["Inspect API"],
      agents: [agent({ label: "inspect api", phase: "Inspect API" })],
    }),
  );

  assert.ok(lines.some((line) => line.includes("Inspect API 1/1")));
});

test("renderWorkflowText respects log limits", () => {
  const text = renderWorkflowText(
    snapshot({
      logs: ["first", "second", "third"],
    }),
    true,
    { maxLogs: 1 },
  );

  assert.doesNotMatch(text, /log: first/);
  assert.doesNotMatch(text, /log: second/);
  assert.match(text, /log: third/);
});

test("renderWorkflowLines separates logs from progress", () => {
  const lines = renderWorkflowLines(
    snapshot({
      agents: [agent()],
      logs: ["finished scan"],
    }),
  );

  const logIndex = lines.findIndex((line) => line.includes("log: finished scan"));
  assert.ok(logIndex > 0);
  assert.equal(lines[logIndex - 1], "");
});

// ===== 窄终端渲染安全性测试 =====
// 回归：pi-crash 当终端分屏宽度变窄时，renderWorkflowWidgetLines 渲染的行
// 可见宽度超过终端宽度，导致 pi-tui 抛出 uncaughtException 崩溃。

/**
 * 计算字符串的终端可见宽度，忽略 ANSI 转义序列，考虑 CJK 双宽字符。
 * 仿 pi-tui visibleWidth 的关键行为，用于测试断言。
 */
function visibleWidth(str: string): number {
  // 去除 ANSI 转义序列
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 测试需要匹配 ANSI 转义序列
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

test("renderWorkflowWidgetLines: 窄终端宽度 43 时所有行可见宽度不超过 43", () => {
  // 模拟崩溃日志中的场景：长 phase 名 + 多 agent
  const snap = snapshot({
    name: "hscode_v3_backend_impl",
    phases: [
      "Batch 2：调拨包裹聚合 + 波次聚合（并行）",
      "Batch 3：分波 → 波次内分箱 → 调拨包裹映射（串行，共改 AllocationVoucherApplicationService）",
    ],
    agents: [
      agent({ id: 1, label: "U2 调拨包裹聚合", phase: "Batch 2：调拨包裹聚合 + 波次聚合（并行）", status: "done" }),
      agent({ id: 2, label: "U3 波次聚合", phase: "Batch 2：调拨包裹聚合 + 波次聚合（并行）", status: "done" }),
      agent({
        id: 3,
        label: "U4 分波算法",
        phase: "Batch 3：分波 → 波次内分箱 → 调拨包裹映射（串行，共改 AllocationVoucherApplicationService）",
        status: "done",
      }),
      agent({
        id: 4,
        label: "U5 波次内分箱",
        phase: "Batch 3：分波 → 波次内分箱 → 调拨包裹映射（串行，共改 AllocationVoucherApplicationService）",
        status: "done",
      }),
      agent({
        id: 5,
        label: "U6 调拨包裹映射",
        phase: "Batch 3：分波 → 波次内分箱 → 调拨包裹映射（串行，共改 AllocationVoucherApplicationService）",
        status: "running",
      }),
    ],
  });

  const lines = renderWorkflowWidgetLines(snap, 43);
  for (const line of lines) {
    const w = visibleWidth(line);
    assert.ok(w <= 43, `行可见宽度 ${w} 超过终端宽度 43：${line}`);
  }
});

test("renderWorkflowWidgetLines: 极窄终端宽度 20 时所有行可见宽度不超过 20", () => {
  const snap = snapshot({
    name: "very_long_workflow_name_that_exceeds_width",
    phases: ["PhaseWithLongName"],
    agents: [agent({ id: 1, label: "some agent with a long label", phase: "PhaseWithLongName", status: "running" })],
  });

  const lines = renderWorkflowWidgetLines(snap, 20);
  for (const line of lines) {
    const w = visibleWidth(line);
    assert.ok(w <= 20, `行可见宽度 ${w} 超过终端宽度 20：${line}`);
  }
});

test("renderWorkflowWidgetLines: boxWidth 不超过终端实际宽度", () => {
  // 原先 Math.max(50, width) 会把 boxWidth 强制设为 50，
  // 当终端宽度 < 50 时会导致渲染行超出终端宽度而崩溃。
  const snap = snapshot({
    name: "test",
    phases: [],
    agents: [],
  });

  // 终端宽度 43（崩溃日志中的值）— boxWidth 必须跟随为 43，不能是 50
  const lines43 = renderWorkflowWidgetLines(snap, 43);
  const topLine43 = lines43[0];
  assert.ok(visibleWidth(topLine43) <= 43, `boxWidth 应不超过 43，但顶行可见宽度为 ${visibleWidth(topLine43)}`);

  // 终端宽度 30 — boxWidth 跟随为 30
  const lines30 = renderWorkflowWidgetLines(snap, 30);
  const topLine30 = lines30[0];
  assert.ok(visibleWidth(topLine30) <= 30, `boxWidth 应不超过 30，但顶行可见宽度为 ${visibleWidth(topLine30)}`);

  // 终端宽度 120 — boxWidth 跟随为 120（修复后不再被上限 50 限制）
  const lines120 = renderWorkflowWidgetLines(snap, 120);
  const topLine120 = lines120[0];
  assert.equal(
    visibleWidth(topLine120),
    120,
    `boxWidth 应跟随终端宽度 120，但顶行可见宽度为 ${visibleWidth(topLine120)}`,
  );
});

test("renderWorkflowWidgetLines: 长 phase 名被截断不溢出", () => {
  const longPhaseName = "Batch 3：分波 → 波次内分箱 → 调拨包裹映射（串行，共改 AllocationVoucherApplicationService）";
  const snap = snapshot({
    name: "test",
    phases: [longPhaseName],
    agents: [agent({ id: 1, label: "U4", phase: longPhaseName, status: "running" })],
  });

  // 在宽度 43 的终端下，长 phase 名必须被截断
  const lines = renderWorkflowWidgetLines(snap, 43);
  const phaseLine = lines.find((l) => l.includes("Batch 3"));
  assert.ok(phaseLine, "应包含 phase 行");
  assert.ok(visibleWidth(phaseLine) <= 43, `phase 行可见宽度 ${visibleWidth(phaseLine)} 超过 43`);
  // 截断后应包含省略号
  assert.ok(phaseLine.includes("…"), "长 phase 名应被截断并显示省略号");
});

test("renderWorkflowWidgetLines: 多种终端宽度下所有行均不溢出（fuzz）", () => {
  // 模拟崩溃日志场景：超长 phase 名 + 多 agent + 超长 workflow 名
  const longPhase = "Batch 3：分波 → 波次内分箱 → 调拨包裹映射（串行，共改 AllocationVoucherApplicationService）";
  const snap = snapshot({
    name: "hscode_v3_backend_impl_with_very_long_name_that_exceeds_normal_width",
    phases: ["短Phase", longPhase],
    agents: [
      agent({ id: 1, label: "短标签", phase: "短Phase", status: "done" }),
      agent({ id: 2, label: "一个比较长的 agent 标签用于测试截断", phase: longPhase, status: "running" }),
      agent({ id: 3, label: "another long label for testing truncation behavior", phase: longPhase, status: "queued" }),
      agent({
        id: 4,
        label: "U4",
        phase: longPhase,
        status: "error",
        error: "编译失败：找不到符号 AllocationVoucherApplicationService",
      }),
      agent({ id: 5, label: "U5", phase: longPhase, status: "done" }),
      agent({ id: 6, label: "U6", phase: longPhase, status: "done" }),
      agent({ id: 7, label: "U7", phase: longPhase, status: "done" }),
      agent({ id: 8, label: "U8", phase: longPhase, status: "skipped" }),
      agent({ id: 9, label: "U9", phase: longPhase, status: "done" }), // 超过 MAX_VISIBLE_AGENTS
    ],
  });

  // 测试从 20 到 120 的所有宽度（pi UI 在 20 列以下基本不可用）
  for (let w = 20; w <= 120; w++) {
    const lines = renderWorkflowWidgetLines(snap, w);
    for (const line of lines) {
      const vw = visibleWidth(line);
      assert.ok(vw <= w, `宽度 ${w} 时行可见宽度 ${vw} 超过终端宽度：${line}`);
    }
  }
});
