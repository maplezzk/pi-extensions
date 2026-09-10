import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  bodyOffset,
  documentDigest,
  frontmatterFor,
  frontmatterUpToDate,
  renderFrontmatter,
  stripFrontmatter,
  withFrontmatter,
  type FrontmatterFields,
} from "../src/frontmatter.ts";
import { createState } from "../src/state.ts";

const fields = (overrides: Partial<FrontmatterFields> = {}): FrontmatterFields => ({
  slug: "demo",
  artifact: "requirements",
  title: "演示规格",
  profile: "strict",
  phase: "requirements",
  status: "drafting",
  approval: "draft",
  approvedAt: null,
  taskProgress: null,
  notice: "notice",
  ...overrides,
});

const wholeFileDigest = (text: string) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("frontmatter 边界识别", () => {
  test("没有 frontmatter 时正文即全文", () => {
    const text = "# 标题\n正文\n";
    assert.equal(bodyOffset(text), 0);
    assert.equal(stripFrontmatter(text), text);
  });

  test("识别标准区块并保留正文首行", () => {
    const text = renderFrontmatter(fields()) + "# 标题\n";
    assert.equal(bodyOffset(text), renderFrontmatter(fields()).length);
    assert.equal(stripFrontmatter(text), "# 标题\n");
  });

  test("支持 CRLF 与空区块", () => {
    assert.equal(stripFrontmatter("---\r\nphase: x\r\n---\r\nbody"), "body");
    assert.equal(bodyOffset("---\n---\nbody"), "---\n---\n".length);
  });

  test("未闭合分隔行按全文处理，不吞掉正文", () => {
    const text = "---\n还是正文\n没有结束行\n";
    assert.equal(bodyOffset(text), 0);
    assert.equal(stripFrontmatter(text), text);
  });

  test("正文中间的 --- 不被当作 frontmatter", () => {
    const text = "# 标题\n\n---\n\n分隔线\n";
    assert.equal(bodyOffset(text), 0);
  });

  test("第一行不是独立分隔行时不识别", () => {
    assert.equal(bodyOffset("-----\n正文\n---\n"), 0);
    assert.equal(bodyOffset("标题\n---\n正文\n"), 0);
  });
});

describe("正文指纹", () => {
  test("无 frontmatter 的文档与 v1 整文件指纹逐字节一致", () => {
    const text = "# Requirements\n\n### REQ-001\n";
    assert.equal(documentDigest(text), wholeFileDigest(text));
    assert.equal(documentDigest(Buffer.from(text, "utf8")), wholeFileDigest(text));
  });

  test("只改派生 frontmatter 不改变指纹", () => {
    const body = "# Requirements\n\n### REQ-001\n";
    const before = withFrontmatter(body, fields());
    const after = withFrontmatter(body, fields({ status: "awaiting_approval", approval: "pending" }));
    assert.notEqual(before, after);
    assert.equal(documentDigest(before), documentDigest(after));
    assert.equal(documentDigest(before), documentDigest(body));
  });

  test("改正文会改变指纹", () => {
    const before = withFrontmatter("正文 A\n", fields());
    const after = withFrontmatter("正文 B\n", fields());
    assert.notEqual(documentDigest(before), documentDigest(after));
    assert.notEqual(documentDigest(before), wholeFileDigest(before));
  });

  test("正文含无效 UTF-8 字节时仍按字节比对", () => {
    const raw = Buffer.concat([Buffer.from("正文 ", "utf8"), Buffer.from([0xff, 0xfe]), Buffer.from("\n")]);
    const withHeader = Buffer.concat([Buffer.from(renderFrontmatter(fields()), "utf8"), raw]);
    assert.equal(documentDigest(withHeader), `sha256:${createHash("sha256").update(raw).digest("hex")}`);
  });
});

describe("派生区块渲染与替换", () => {
  test("键顺序稳定，进度只在提供时出现", () => {
    const rendered = renderFrontmatter(fields({ taskProgress: { done: 2, total: 5 } }));
    const keys = rendered
      .split("\n")
      .filter((line) => /^[a-z_]+:/.test(line))
      .map((line) => line.split(":")[0]);
    assert.deepEqual(keys, [
      "spec",
      "artifact",
      "title",
      "profile",
      "phase",
      "status",
      "approval",
      "tasks_done",
    ]);
    assert.match(rendered, /^---\n# notice\nspec: demo\n/);
    assert.doesNotMatch(renderFrontmatter(fields()), /tasks_done/);
  });

  test("提示行与标题里的换行不会破坏区块", () => {
    const rendered = renderFrontmatter(fields({ notice: "第一行\n第二行", title: '带"引号"的\n标题' }));
    assert.equal(rendered.split("\n").filter((line) => line === "---").length, 2);
    assert.match(rendered, /^# 第一行 第二行$/m);
    // 标题用 JSON 转义：换行变成 \\n，仍占一行，不会提前结束区块
    assert.match(rendered, /^title: "带\\"引号\\"的\\n标题"$/m);
  });

  test("替换手工写的区块时正文逐字节不变", () => {
    const body = "# 正文\n\n内容\n";
    const handWritten = `---\nphase: complete\napproved: true\n---\n${body}`;
    const next = withFrontmatter(handWritten, fields({ phase: "tasks" }));
    assert.equal(stripFrontmatter(next), body);
    assert.match(next, /^phase: tasks$/m);
    assert.doesNotMatch(next, /approved: true/);
  });

  test("重复同步幂等，并可由 frontmatterUpToDate 判定", () => {
    const once = withFrontmatter("# 正文\n", fields());
    assert.equal(withFrontmatter(once, fields()), once);
    assert.equal(frontmatterUpToDate(once, fields()), true);
    assert.equal(frontmatterUpToDate(once, fields({ status: "done" })), false);
    assert.equal(frontmatterUpToDate("# 正文\n", fields()), false);
  });
});

describe("从 state 派生字段", () => {
  test("审批状态映射为可读一行", () => {
    const state = createState("demo", "演示规格", "strict");
    assert.equal(frontmatterFor({ state, artifact: "requirements", taskProgress: null, notice: "n" }).approval, "draft");

    state.artifacts.requirements = { sha256: "sha256:x" };
    assert.equal(frontmatterFor({ state, artifact: "requirements", taskProgress: null, notice: "n" }).approval, "pending");

    state.artifacts.requirements = {
      sha256: "sha256:x",
      approvedSha256: "sha256:x",
      approvalKind: "human",
      approvedAt: "2026-09-10T00:00:00.000Z",
    };
    const human = frontmatterFor({ state, artifact: "requirements", taskProgress: null, notice: "n" });
    assert.equal(human.approval, "human");
    assert.equal(human.approvedAt, "2026-09-10T00:00:00.000Z");

    state.profile = "quick";
    state.artifacts.requirements.approvalKind = "accepted-by-profile";
    assert.equal(
      frontmatterFor({ state, artifact: "requirements", taskProgress: { done: 1, total: 3 }, notice: "n" }).approval,
      "accepted-by-profile",
    );
  });
});
