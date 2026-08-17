import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const EXECUTABLE_FILE_MODE = 0o755;

let backend: typeof import("../src/backends/herdr.ts");
let tempDirectory = "";
let commandLog = "";
let closeFailureMarker = "";

const originalEnvironment = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
  HERDR_TAB_ID: process.env.HERDR_TAB_ID,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_TEST_LOG: process.env.HERDR_TEST_LOG,
  HERDR_TEST_CLOSE_FAILURE_MARKER: process.env.HERDR_TEST_CLOSE_FAILURE_MARKER,
  PI_SUBAGENT_HERDR_MODE: process.env.PI_SUBAGENT_HERDR_MODE,
  PATH: process.env.PATH,
};

/** 读取 fake herdr 的逐行 JSON 参数记录；空日志返回空数组。 */
function readRecordedCommands(): string[][] {
  if (!existsSync(commandLog)) return [];
  const content = readFileSync(commandLog, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line) as string[]);
}

before(async () => {
  tempDirectory = mkdtempSync(join(tmpdir(), "pi-terminal-mux-herdr-test-"));
  commandLog = join(tempDirectory, "commands.jsonl");
  closeFailureMarker = join(tempDirectory, "fail-next-close");
  const fakeHerdr = join(tempDirectory, "herdr");
  writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, unlinkSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "workspace" && args[1] === "get") {
  process.stdout.write(JSON.stringify({ result: { workspace: { label: "test-workspace" } } }));
} else if (args[0] === "tab" && args[1] === "create") {
  process.stdout.write(JSON.stringify({
    result: {
      tab: { tab_id: "w-test:t2" },
      root_pane: { pane_id: "w-test:p2" },
    },
  }));
} else if (args[0] === "pane" && args[1] === "split") {
  process.stdout.write(JSON.stringify({ result: { pane: { pane_id: "w-test:p99" } } }));
} else if (
  args[0] === "tab" &&
  args[1] === "close" &&
  existsSync(process.env.HERDR_TEST_CLOSE_FAILURE_MARKER)
) {
  unlinkSync(process.env.HERDR_TEST_CLOSE_FAILURE_MARKER);
  process.stderr.write("simulated tab close failure");
  process.exit(1);
}
`,
    { mode: EXECUTABLE_FILE_MODE },
  );

  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "w-test";
  process.env.HERDR_TAB_ID = "w-test:t1";
  process.env.HERDR_PANE_ID = "w-test:p1";
  process.env.HERDR_TEST_LOG = commandLog;
  process.env.HERDR_TEST_CLOSE_FAILURE_MARKER = closeFailureMarker;
  delete process.env.PI_SUBAGENT_HERDR_MODE;
  process.env.PATH = `${tempDirectory}${delimiter}${originalEnvironment.PATH ?? ""}`;

  const backendUrl = new URL("../src/backends/herdr.ts", import.meta.url);
  backendUrl.searchParams.set("test", "tab-surface");
  backend = await import(backendUrl.href) as typeof import("../src/backends/herdr.ts");
});

after(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (tempDirectory) rmSync(tempDirectory, { recursive: true, force: true });
});

test("herdr surface 模式默认 split，并校验显式配置", () => {
  assert.equal(backend.resolveHerdrSurfaceMode(), "split");
  assert.equal(backend.resolveHerdrSurfaceMode(" split "), "split");
  assert.equal(backend.resolveHerdrSurfaceMode("TAB"), "tab");
  assert.throws(() => backend.resolveHerdrSurfaceMode("tiles"), /split.*tab/);
});

test("herdr runtime 仅在 tab 模式额外要求 workspace 上下文", () => {
  assert.equal(backend.isHerdrRuntimeAvailable(), true);
  delete process.env.HERDR_WORKSPACE_ID;
  try {
    assert.equal(backend.isHerdrRuntimeAvailable(), true);
    process.env.PI_SUBAGENT_HERDR_MODE = "tab";
    assert.equal(backend.isHerdrRuntimeAvailable(), false);
  } finally {
    delete process.env.PI_SUBAGENT_HERDR_MODE;
    process.env.HERDR_WORKSPACE_ID = "w-test";
  }
});

test("herdr 未配置模式时保持 BFS 分屏", () => {
  const commandOffset = readRecordedCommands().length;
  const surface = backend.createHerdrSurface("default split agent");
  assert.equal(surface, "w-test:p99");
  backend.closeHerdrSurface(surface);

  assert.deepEqual(readRecordedCommands().slice(commandOffset), [
    ["pane", "split", "w-test:p1", "--direction", "right", "--no-focus"],
    ["workspace", "get", "w-test"],
    ["pane", "rename", "w-test:p99", "test-workspace[default split agent]"],
    ["pane", "close", "w-test:p99"],
  ]);
});

test("herdr tab 模式创建独立 tab，并按 tab 重命名与关闭", () => {
  const commandOffset = readRecordedCommands().length;
  process.env.PI_SUBAGENT_HERDR_MODE = "tab";
  try {
    const surface = backend.createHerdrSurface("review agent");
    assert.equal(surface, "w-test:p2");

    backend.ops.rename(surface, "renamed agent");
    backend.closeHerdrSurface(surface);
  } finally {
    delete process.env.PI_SUBAGENT_HERDR_MODE;
  }

  const commands = readRecordedCommands().slice(commandOffset);

  assert.deepEqual(commands, [
    ["workspace", "get", "w-test"],
    [
      "tab",
      "create",
      "--workspace",
      "w-test",
      "--cwd",
      process.cwd(),
      "--label",
      "test-workspace[review agent]",
      "--no-focus",
    ],
    ["workspace", "get", "w-test"],
    ["tab", "rename", "w-test:t2", "test-workspace[renamed agent]"],
    ["tab", "close", "w-test:t2"],
  ]);
  assert.equal(commands.some((args) => args[0] === "pane" && args[1] === "split"), false);
  assert.equal(commands.some((args) => args[0] === "pane" && args[1] === "close"), false);
});

test("herdr tab 关闭失败后重试仍关闭 tab", () => {
  const commandOffset = readRecordedCommands().length;
  process.env.PI_SUBAGENT_HERDR_MODE = "tab";
  let surface = "";
  try {
    surface = backend.createHerdrSurface("retry agent");
  } finally {
    delete process.env.PI_SUBAGENT_HERDR_MODE;
  }
  writeFileSync(closeFailureMarker, "fail once");

  assert.throws(() => backend.closeHerdrSurface(surface), /Command failed/);
  backend.closeHerdrSurface(surface);

  const commands = readRecordedCommands().slice(commandOffset);
  const closeCommands = commands.filter((args) => args[1] === "close");
  assert.deepEqual(closeCommands, [
    ["tab", "close", "w-test:t2"],
    ["tab", "close", "w-test:t2"],
  ]);
  assert.equal(commands.some((args) => args[0] === "pane" && args[1] === "close"), false);
});

test("herdr 显式 createSplit 继续创建 pane 并按 pane 关闭", () => {
  const commandOffset = readRecordedCommands().length;
  const surface = backend.ops.createSplit("split agent", "left", "w-test:p1");
  assert.equal(surface, "w-test:p99");
  backend.closeHerdrSurface(surface);

  assert.deepEqual(readRecordedCommands().slice(commandOffset), [
    ["pane", "split", "w-test:p1", "--direction", "right", "--no-focus"],
    ["workspace", "get", "w-test"],
    ["pane", "rename", "w-test:p99", "test-workspace[split agent]"],
    ["pane", "close", "w-test:p99"],
  ]);
});
