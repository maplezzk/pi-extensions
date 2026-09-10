import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderSpecProgressLines,
  renderSpecProgressText,
  type SpecProgressSnapshot,
  type SpecProgressTheme,
} from "../src/display.ts";

const theme: SpecProgressTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const snapshot: SpecProgressSnapshot = {
  name: "oauth-登录流程",
  profile: "strict",
  status: "机器状态：design.awaiting_approval",
  rows: [
    { label: "需求", state: "done", detail: "已完成" },
    { label: "设计", state: "waiting", detail: "待审批" },
    { label: "任务", state: "queued" },
    { label: "实现", state: "queued" },
    { label: "验证", state: "queued" },
  ],
  currentTask: "下一任务：TASK-build-widget",
};

describe("Workflow 风格 Spec 进度 Widget", () => {
  test("宽终端渲染边框、阶段和任务", () => {
    const lines = renderSpecProgressLines(snapshot, theme, 60);
    assert.ok(lines[0].startsWith("╭"));
    assert.ok(lines.at(-1)?.startsWith("╰"));
    assert.ok(lines.some((line) => line.includes("✓ 需求")));
    assert.ok(lines.some((line) => line.includes("◆ 设计")));
    assert.ok(lines.some((line) => line.includes("TASK-build-widget")));
  });

  test("所有行严格不超过可用宽度", () => {
    for (const width of [20, 32, 48, 80]) {
      const lines = renderSpecProgressLines(snapshot, theme, width);
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `width=${width}, actual=${visibleWidth(line)}, line=${line}`,
        );
      }
    }
  });

  test("极窄终端退化为单行，不溢出", () => {
    const lines = renderSpecProgressLines(snapshot, theme, 3);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= 3);
  });

  test("文本版本包含相同阶段状态", () => {
    const lines = renderSpecProgressText(snapshot);
    assert.ok(lines[0].includes("oauth-登录流程"));
    assert.ok(lines.some((line) => line.includes("✓ 需求")));
    assert.ok(lines.some((line) => line.includes("◆ 设计")));
    assert.ok(lines.at(-1)?.includes("design.awaiting_approval"));
  });
});
