import assert from "node:assert/strict";
import { test } from "node:test";
import { collectPublishedPackageDirectories } from "./release-publish-coverage.mjs";

test("合并 matrix 与专用 job 的发布目录", () => {
  const workflow = `
  publish-npm:
    strategy:
      matrix:
        include:
          - dir: packages/independent
    steps:
      - name: Publish
        working-directory: \${{ matrix.dir }}
  publish-dependent:
    steps:
      - name: Publish
        working-directory: packages/dependency
  publish-retry:
    steps:
      - name: Publish
        working-directory: \${{ inputs.package_dir }}
`;
  assert.deepEqual(collectPublishedPackageDirectories(workflow), [
    "packages/independent",
    "packages/dependency",
  ]);
});

test("专用 job 目录与 matrix 重复时只计一次", () => {
  const workflow = `
          - dir: packages/shared
      - working-directory: packages/shared
`;
  assert.deepEqual(collectPublishedPackageDirectories(workflow), ["packages/shared"]);
});
