import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const packageDirectory = "packages/pi-terminal-mux";
const namingDirectory = "packages/pi-naming";

assert.match(workflow, /publish-terminal-mux:\n    needs: release-please\n    if: \$\{\{ github\.event_name == 'push' && contains\(needs\.release-please\.outputs\.paths_released, 'packages\/pi-terminal-mux'\) \}\}/);
assert.match(workflow, /publish-naming:\n    needs: \[release-please, publish-terminal-mux\]\n    if: \$\{\{ always\(\) && github\.event_name == 'push' && contains\(needs\.release-please\.outputs\.paths_released, 'packages\/pi-naming'\) && \(needs\.publish-terminal-mux\.result == 'success' \|\| needs\.publish-terminal-mux\.result == 'skipped'\) \}\}/);

const independentPublish = workflow.match(/publish-npm:\n[\s\S]*?\n  publish-terminal-mux:/)?.[0];
assert.ok(independentPublish, "missing independent package publish job");
assert.ok(!independentPublish.includes(packageDirectory), "terminal-mux must not publish in parallel with naming");
assert.ok(!independentPublish.includes(namingDirectory), "naming must wait for terminal-mux");
assert.match(workflow, /Verify published terminal-mux dependency\n        working-directory: packages\/pi-naming\n        run: \|\n          RANGE=\$\(node -p "require\('\.\/package\.json'\)\.dependencies\['pi-terminal-mux'\]\"\)\n          npm view "pi-terminal-mux@\$RANGE" version > \/dev\/null/);
assert.match(workflow, /Verify published terminal-mux dependency for naming retry\n        if: \$\{\{ inputs\.package_dir == 'packages\/pi-naming' \}\}/);

console.log("Release order check passed: terminal-mux publishes before pi-naming when both release.");
