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
let splitStateMarker = "";

const originalEnvironment = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
  HERDR_TAB_ID: process.env.HERDR_TAB_ID,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_TEST_LOG: process.env.HERDR_TEST_LOG,
  HERDR_TEST_CLOSE_FAILURE_MARKER: process.env.HERDR_TEST_CLOSE_FAILURE_MARKER,
  HERDR_TEST_FAIL_PANE_ID: process.env.HERDR_TEST_FAIL_PANE_ID,
  HERDR_TEST_EMPTY_SPLIT: process.env.HERDR_TEST_EMPTY_SPLIT,
  HERDR_TEST_WHITESPACE_SPLIT: process.env.HERDR_TEST_WHITESPACE_SPLIT,
  HERDR_TEST_WHITESPACE_TAB_ROOT: process.env.HERDR_TEST_WHITESPACE_TAB_ROOT,
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
  splitStateMarker = "/tmp/herdr-subagent-pane-w-test_p1.json";
  rmSync(splitStateMarker, { force: true });
  rmSync(`${splitStateMarker}.lock`, { recursive: true, force: true });
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
      root_pane: { pane_id: process.env.HERDR_TEST_WHITESPACE_TAB_ROOT === "1" ? "   " : "w-test:p2" },
    },
  }));
} else if (args[0] === "pane" && args[1] === "split") {
  if (args[2] === process.env.HERDR_TEST_FAIL_PANE_ID) {
    process.stderr.write("simulated pane split failure");
    process.exit(1);
  }
  if (process.env.HERDR_TEST_EMPTY_SPLIT === "1") {
    process.stdout.write(JSON.stringify({ result: {} }));
  } else if (process.env.HERDR_TEST_WHITESPACE_SPLIT === "1") {
    process.stdout.write(JSON.stringify({ result: { pane: { pane_id: "   " } } }));
  } else {
    process.stdout.write(JSON.stringify({ result: { pane: { pane_id: "w-test:p99" } } }));
  }
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
  rmSync(splitStateMarker, { force: true });
  rmSync(`${splitStateMarker}.lock`, { recursive: true, force: true });
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

test("herdr 创建失败时不返回空 surface 或向空 pane ID 发送命令", (): void => {
  const commandOffset = readRecordedCommands().length;
  rmSync(splitStateMarker, { force: true });
  process.env.HERDR_TEST_EMPTY_SPLIT = "1";
  try {
    assert.throws(() => backend.createHerdrSurface("empty split agent"), /pane ID/);
    assert.throws(() => backend.sendHerdrCommand("   ", "echo should-not-run"), /pane ID/);
  } finally {
    delete process.env.HERDR_TEST_EMPTY_SPLIT;
  }

  const commands = readRecordedCommands().slice(commandOffset);
  assert.deepEqual(commands, [
    ["pane", "split", "w-test:p1", "--direction", "right", "--no-focus"],
  ]);
  assert.equal(commands.some((args) => args[0] === "pane" && args[1] === "run"), false);
});

test("herdr 拒绝 CLI 返回的空白 pane ID，不向其执行后续命令", (): void => {
  const commandOffset = readRecordedCommands().length;
  rmSync(splitStateMarker, { force: true });
  process.env.HERDR_TEST_WHITESPACE_SPLIT = "1";
  try {
    assert.throws(() => backend.createHerdrSurface("whitespace split agent"), /pane ID/);
  } finally {
    delete process.env.HERDR_TEST_WHITESPACE_SPLIT;
  }

  assert.deepEqual(readRecordedCommands().slice(commandOffset), [
    ["pane", "split", "w-test:p1", "--direction", "right", "--no-focus"],
  ]);
});

test("herdr 不将 marker 中的空白 pane ID 用作 split source", (): void => {
  const commandOffset = readRecordedCommands().length;
  writeFileSync(splitStateMarker, JSON.stringify({
    panes: ["   "],
    pos: 0,
    base: 1,
    dir: "right",
  }));

  const surface = backend.createHerdrSurface("cached whitespace split agent");
  assert.equal(surface, "w-test:p99");
  backend.closeHerdrSurface(surface);

  assert.deepEqual(readRecordedCommands().slice(commandOffset), [
    ["pane", "split", "w-test:p1", "--direction", "right", "--no-focus"],
    ["workspace", "get", "w-test"],
    ["pane", "rename", "w-test:p99", "test-workspace[cached whitespace split agent]"],
    ["pane", "close", "w-test:p99"],
  ]);
});

test("herdr 恢复失效 split source 后仅持久化新的 BFS 状态", (): void => {
  const commandOffset = readRecordedCommands().length;
  writeFileSync(splitStateMarker, JSON.stringify({
    panes: ["w-test:gone"],
    pos: 0,
    base: 1,
    dir: "down",
  }));
  process.env.HERDR_TEST_FAIL_PANE_ID = "w-test:gone";
  let surface = "";
  try {
    surface = backend.createHerdrSurface("recovered split agent");
  } finally {
    delete process.env.HERDR_TEST_FAIL_PANE_ID;
  }

  assert.equal(surface, "w-test:p99");
  assert.equal(readFileSync(splitStateMarker, "utf8"), JSON.stringify({
    panes: ["w-test:p99"],
    pos: 0,
    base: 1,
    dir: "down",
  }));
  assert.deepEqual(readRecordedCommands().slice(commandOffset), [
    ["pane", "split", "w-test:gone", "--direction", "down", "--no-focus"],
    ["pane", "split", "w-test:p1", "--direction", "right", "--no-focus"],
    ["workspace", "get", "w-test"],
    ["pane", "rename", "w-test:p99", "test-workspace[recovered split agent]"],
  ]);
  backend.closeHerdrSurface(surface);
});

test("herdr tab 模式拒绝空白 root pane ID", (): void => {
  const commandOffset = readRecordedCommands().length;
  process.env.PI_SUBAGENT_HERDR_MODE = "tab";
  process.env.HERDR_TEST_WHITESPACE_TAB_ROOT = "1";
  try {
    assert.throws(() => backend.createHerdrSurface("whitespace tab agent"), /Unexpected herdr tab create output/);
  } finally {
    delete process.env.HERDR_TEST_WHITESPACE_TAB_ROOT;
    delete process.env.PI_SUBAGENT_HERDR_MODE;
  }

  assert.deepEqual(readRecordedCommands().slice(commandOffset), [
    ["workspace", "get", "w-test"],
    [
      "tab",
      "create",
      "--workspace",
      "w-test",
      "--cwd",
      process.cwd(),
      "--label",
      "test-workspace[whitespace tab agent]",
      "--no-focus",
    ],
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
