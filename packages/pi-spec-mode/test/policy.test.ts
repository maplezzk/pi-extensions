import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveInside,
  parseSpecSlug,
  phaseTools,
  executeTools,
  isUnderSpecDir,
  isStateFile,
  specDirFor,
  artifactFileFor,
  allowedArtifactForPhase,
  sameResolvedPath,
  isUnderSpecsRoot,
  verificationTools,
} from "../src/policy.ts";
import { createState, type StateFile } from "../src/state.ts";

function tmpBase(): string {
  return mkdtempSync(join(tmpdir(), "pi-spec-policy-"));
}

describe("resolveInside 路径守卫", () => {
  test("拒绝空路径与越界相对路径", () => {
    const base = tmpBase();
    assert.equal(resolveInside(base, ""), false);
    assert.equal(resolveInside(base, "../outside"), false);
    assert.equal(resolveInside(base, "../../etc/passwd"), false);
  });

  test("拒绝绝对路径逃逸", () => {
    const base = tmpBase();
    assert.equal(resolveInside(base, "/etc/passwd"), false);
  });

  test("允许 base 内相对路径", () => {
    const base = tmpBase();
    assert.equal(resolveInside(base, "a/b.md"), true);
    assert.equal(resolveInside(base, "design.md"), true);
  });

  test("拒绝符号链接逃逸", () => {
    const base = tmpBase();
    const outside = tmpBase();
    mkdirSync(join(base, "spec"), { recursive: true });
    symlinkSync(outside, join(base, "spec", "link"));
    assert.equal(resolveInside(join(base, "spec"), "link/evil.md"), false);
  });
});

describe("slug 校验", () => {
  test("合法 slug", () => {
    assert.equal(parseSpecSlug("oauth-login"), "oauth-login");
    assert.equal(parseSpecSlug("a1"), "a1");
  });

  test("非法 slug 返回 null", () => {
    assert.equal(parseSpecSlug("OAuth"), null);
    assert.equal(parseSpecSlug("-leading"), null);
    assert.equal(parseSpecSlug("trailing-"), null);
    assert.equal(parseSpecSlug("a b"), null);
    assert.equal(parseSpecSlug("a/b"), null);
  });
});

describe("工具集", () => {
  test("计划阶段追加 write/edit/spec_submit 并移除 bash", () => {
    const tools = phaseTools(["read", "bash", "edit", "write", "grep"]);
    assert.ok(tools.includes("spec_submit"));
    assert.ok(tools.includes("write"));
    assert.ok(!tools.includes("bash"));
    assert.ok(tools.includes("read"));
  });

  test("验证阶段在原工具含 bash 时保留 bash", () => {
    const tools = verificationTools(["read", "bash", "write"]);
    assert.ok(tools.includes("bash"));
    assert.ok(tools.includes("spec_submit"));
  });

  test("验证阶段不强行启用原本禁用的 bash", () => {
    const tools = verificationTools(["read", "write"]);
    assert.ok(!tools.includes("bash"));
  });

  test("执行阶段移除 spec_submit 恢复其余", () => {
    const tools = executeTools(["read", "bash", "edit", "write", "spec_submit"]);
    assert.deepEqual(tools, ["read", "bash", "edit", "write"]);
  });
});

describe("规格目录识别", () => {
  const cwd = tmpBase();
  const slug = "demo";

  test("specDirFor / artifactFileFor 路径", () => {
    assert.equal(specDirFor(cwd, slug), join(cwd, ".pi/specs", slug));
    assert.equal(
      artifactFileFor(cwd, slug, "design"),
      join(cwd, ".pi/specs", slug, "design.md"),
    );
  });

  test("isUnderSpecDir", () => {
    const dir = specDirFor(cwd, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "design.md"), "");
    assert.equal(isUnderSpecDir(cwd, slug, join(dir, "design.md")), true);
    assert.equal(isUnderSpecDir(cwd, slug, join(cwd, "src", "x.ts")), false);
  });

  test("isStateFile 只认 basename", () => {
    assert.equal(
      isStateFile(join(cwd, ".pi/specs/demo/state.json")),
      true,
    );
    assert.equal(isStateFile(join(cwd, "x/state.json.bak")), false);
  });

  test("isUnderSpecsRoot 识别所有规格目录", () => {
    assert.equal(
      isUnderSpecsRoot(cwd, join(cwd, ".pi/specs/other/state.json")),
      true,
    );
    assert.equal(isUnderSpecsRoot(cwd, join(cwd, "src/x.ts")), false);
  });

  test("sameResolvedPath 精确比较路径", () => {
    const left = join(cwd, ".pi/specs/demo/design.md");
    assert.equal(sameResolvedPath(left, left), true);
    assert.equal(sameResolvedPath(left, join(cwd, "src/design.md")), false);
  });
});

describe("allowedArtifactForPhase", () => {
  const cwd = tmpBase();

  // 构造指定 phase/status 的测试 StateFile
  function at(phase: StateFile["phase"], status: StateFile["status"]): StateFile {
    return { ...createState("demo", "d", "strict"), phase, status } as StateFile;
  }

  test("drafting 阶段返回对应文档", () => {
    const r = allowedArtifactForPhase(at("design", "drafting"), cwd);
    assert.equal(r?.artifact, "design");
    assert.ok(r!.file.endsWith("design.md"));
  });

  test("awaiting_approval 阶段不允许普通写入", () => {
    const r = allowedArtifactForPhase(at("design", "awaiting_approval"), cwd);
    assert.equal(r, null);
  });

  test("实现阶段允许 tasks.md 记录", () => {
    const r = allowedArtifactForPhase(at("implementation", "in_progress"), cwd);
    assert.equal(r?.artifact, "tasks");
  });

  test("完成阶段禁止任何规格文档写入", () => {
    const r = allowedArtifactForPhase(at("complete", "done"), cwd);
    assert.equal(r, null);
  });
});
