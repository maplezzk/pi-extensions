import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { ops } from "../src/backends/cmux.ts";

test("cmux closes live shells, supports older CLIs, and preserves close failures", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-cmux-close-"));
  const log = join(dir, "commands.jsonl");
  const previous = { PATH: process.env.PATH, CMUX_CLOSE_TEST_LOG: process.env.CMUX_CLOSE_TEST_LOG, CMUX_CLOSE_TEST_ERROR: process.env.CMUX_CLOSE_TEST_ERROR };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "cmux"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.CMUX_CLOSE_TEST_LOG, JSON.stringify(args) + "\\n");
if (process.env.CMUX_CLOSE_TEST_ERROR) {
  if (args.includes("--force") || process.env.CMUX_CLOSE_TEST_ERROR === "fallback failure") {
    process.stderr.write(process.env.CMUX_CLOSE_TEST_ERROR === "fallback failure" && args.includes("--force")
      ? "unknown flag: --force" : process.env.CMUX_CLOSE_TEST_ERROR);
    process.exit(1);
  }
} else if (!args.includes("--force")) {
  process.stderr.write("confirmation_required: Surface has a running process; retry with force");
  process.exit(1);
}
`, { mode: 0o755 });
  process.env.PATH = `${dir}${delimiter}${previous.PATH ?? ""}`;
  process.env.CMUX_CLOSE_TEST_LOG = log;
  const commands = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const surface = "surface:123; literal target";
  delete process.env.CMUX_CLOSE_TEST_ERROR;
  ops.close(surface);
  assert.deepEqual(commands(), [["close-surface", "--force", "--surface", surface]]);

  for (const message of ["unknown flag: --force", "Unrecognized option '--force'"]) {
    writeFileSync(log, "");
    process.env.CMUX_CLOSE_TEST_ERROR = message;
    ops.close(surface);
    assert.deepEqual(commands(), [
      ["close-surface", "--force", "--surface", surface],
      ["close-surface", "--surface", surface],
    ]);
  }
  for (const message of ["surface not found", "connection refused", "unknown option: --surface"]) {
    writeFileSync(log, "");
    process.env.CMUX_CLOSE_TEST_ERROR = message;
    assert.throws(() => ops.close(surface));
    assert.equal(commands().length, 1, "unrelated failures must not trigger a retry");
  }
  writeFileSync(log, "");
  process.env.CMUX_CLOSE_TEST_ERROR = "fallback failure";
  assert.throws(() => ops.close(surface), /fallback failure/);
  assert.equal(commands().length, 2, "fallback failures must propagate");
});
