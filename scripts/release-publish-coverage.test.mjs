import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collectPublishedPackageDirectories } from "./release-publish-coverage.mjs";

function workflow(jobs) {
  return `jobs:\n${jobs}`;
}

const publishRun = "npm publish --provenance";

test("真实发布工作流覆盖 matrix 与专用自动发布 job，并去重", () => {
  const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.deepEqual(collectPublishedPackageDirectories(source), [
    "packages/pi-extensions-i18n",
    "packages/pi-distill",
    "packages/pi-tool-supervisor",
    "packages/pi-extensions-tool-display",
    "packages/pi-metrics",
    "packages/pi-models-discovery",
    "packages/pi-session-tools",
    "packages/pi-session-resources",
    "packages/pi-dynamic-workflows",
    "packages/pi-interactive-subagents",
    "packages/pi-safety-guards",
    "packages/pi-nested-skills",
    "packages/pi-notifications",
    "packages/pi-terminal-mux",
    "packages/pi-naming",
  ]);
});

test("registry 验证 step 不是发布覆盖", () => {
  const source = workflow(`
  verify-only:
    steps:
      - working-directory: packages/pi-naming
        run: npm view pi-terminal-mux version
`);
  assert.deepEqual(collectPublishedPackageDirectories(source), []);
});

test("删除专用 naming 或 mux publish step 后不再报告对应覆盖", () => {
  const source = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const withoutMux = source.replace(/\n      - name: Publish to npm\n        working-directory: packages\/pi-terminal-mux\n        run: \|[\s\S]*?\n          fi\n/, "\n");
  assert.ok(!collectPublishedPackageDirectories(withoutMux).includes("packages/pi-terminal-mux"));
  const withoutNaming = source.replace(/\n      - name: Publish to npm\n        working-directory: packages\/pi-naming\n        run: \|[\s\S]*?\n          fi\n/, "\n");
  assert.ok(!collectPublishedPackageDirectories(withoutNaming).includes("packages/pi-naming"));
});

test("只有 matrix 而没有 publish step 不算发布覆盖", () => {
  const source = workflow(`
  publish-npm:
    strategy:
      matrix:
        include:
          - dir: packages/independent
    steps:
      - working-directory: \${{ matrix.dir }}
        run: npm test
`);
  assert.deepEqual(collectPublishedPackageDirectories(source), []);
});

test("matrix 只在同一 publish job 使用 matrix.dir 时展开", () => {
  const source = workflow(`
  unrelated-matrix:
    strategy:
      matrix:
        include:
          - dir: packages/wrong
    steps:
      - run: echo ignored
  publish-npm:
    strategy:
      matrix:
        include:
          - dir: packages/first
          - dir: packages/second
    steps:
      - working-directory: \${{ matrix.dir }}
        run: |
          ${publishRun}
`);
  assert.deepEqual(collectPublishedPackageDirectories(source), ["packages/first", "packages/second"]);
});

test("run 默认目录适用于 publish step，无法解析的目录直接失败", () => {
  const withDefault = `
defaults:
  run:
    working-directory: packages/defaulted
jobs:
  publish-defaulted:
    steps:
      - run: ${publishRun}
`;
  assert.deepEqual(collectPublishedPackageDirectories(withDefault), ["packages/defaulted"]);

  const unresolved = workflow(`
  publish-unknown:
    steps:
      - run: ${publishRun}
`);
  assert.throws(() => collectPublishedPackageDirectories(unresolved), /no resolvable working-directory/);
});
