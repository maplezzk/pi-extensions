import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import bashDirectoryScope from "../src/bash-directory-scope.ts";
import {
  addedDirectoryPathsFromBranch,
  findOutOfScopeBashPaths,
} from "../src/bash-directory-scope-utils.ts";
import {
  i18n,
  SHELL_PARSE_BLOCKED_MESSAGE_KEY,
} from "../src/i18n.ts";

const fixtureRoot = mkdtempSync(join(homedir(), ".pi-bash-scope-"));
const currentDir = join(fixtureRoot, "current");
const addedDir = join(fixtureRoot, "added");
const outsideDir = join(fixtureRoot, "outside");
mkdirSync(currentDir);
mkdirSync(addedDir);
mkdirSync(outsideDir);
writeFileSync(join(currentDir, "inside.txt"), "inside");
writeFileSync(join(addedDir, "added.txt"), "added");
writeFileSync(join(outsideDir, "secret.txt"), "secret");
writeFileSync(join(outsideDir, "run.sh"), "#!/bin/sh\n");
symlinkSync(outsideDir, join(currentDir, "outside-link"), "dir");

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** 使用单引号构造不会被 shell 重新拆词的测试参数。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 返回命令中的范围外路径，简化测试断言。 */
function violations(command: string, externalDirectories: readonly string[] = []) {
  return findOutOfScopeBashPaths(command, currentDir, externalDirectories);
}

test("允许当前目录内的相对路径和绝对路径", () => {
  assert.deepEqual(violations("git status"), []);
  assert.deepEqual(violations("cat inside.txt"), []);
  assert.deepEqual(violations(`cat ${shellQuote(join(currentDir, "inside.txt"))}`), []);
});

test("允许 add_directory 状态中的目录及其后代", () => {
  assert.deepEqual(violations(`git -C ${shellQuote(addedDir)} status`, [addedDir]), []);
  assert.deepEqual(violations(`cat ${shellQuote(join(addedDir, "added.txt"))}`, [addedDir]), []);
});

test("允许 /tmp、/var 及其后代，但不放行同前缀目录", () => {
  assert.deepEqual(violations("ls /tmp"), []);
  assert.deepEqual(violations("cat /tmp/pi-bash-scope/input.txt"), []);
  assert.deepEqual(violations("echo ok > /var/tmp/pi-bash-scope/output.txt"), []);
  assert.equal(violations("cat /tmp-other/secret.txt").length, 1);
  assert.equal(violations("cat /variable/secret.txt").length, 1);
});

test("阻断范围外绝对路径、父目录越界和重定向", () => {
  assert.equal(violations(`cat ${shellQuote(join(outsideDir, "secret.txt"))}`).length, 1);
  assert.equal(violations("ls ../outside").length, 1);
  assert.equal(violations(`echo ok > ${shellQuote(join(outsideDir, "new.txt"))}`).length, 1);
});

test("阻断嵌套 shell、eval、env split-string 与命令替换中的范围外路径", () => {
  const outsideFile = shellQuote(join(outsideDir, "secret.txt"));
  assert.equal(violations(`bash -c ${shellQuote(`cat ${outsideFile}`)}`).length, 1);
  assert.equal(violations(`eval ${shellQuote(`cat ${outsideFile}`)}`).length, 1);
  assert.equal(violations(`env -S ${shellQuote(`cat ${outsideFile}`)}`).length, 1);
  assert.equal(violations(`echo "$(cat ${outsideFile})"`).length, 1);
});

test("阻断范围外脚本作为可执行命令，以及 cd 默认进入家目录", () => {
  assert.equal(violations(shellQuote(join(outsideDir, "run.sh"))).length, 1);
  assert.equal(violations("cd").length, 1);
});

test("阻断通过当前目录符号链接访问范围外目录", () => {
  assert.equal(violations("cat outside-link/secret.txt").length, 1);
  assert.equal(violations("cat outside-link/not-created.txt").length, 1);
});

test("搜索和文本命令只检查真实文件参数", () => {
  const outsideFile = shellQuote(join(outsideDir, "secret.txt"));
  assert.deepEqual(violations(`grep -rn ${shellQuote(outsideDir)} .`), []);
  assert.equal(violations(`grep -r secret ${shellQuote(outsideDir)}`).length, 1);
  assert.equal(violations(`grep -f${outsideFile} .`).length, 1);
  assert.equal(violations(`sed -n ${shellQuote(`/${outsideDir}/p`)} ${outsideFile}`).length, 1);
  assert.equal(violations(`awk -F / ${shellQuote("{ print $1 }")} ${outsideFile}`).length, 1);
  assert.equal(violations(`jq -r .name ${outsideFile}`).length, 1);
  assert.equal(violations(`jq --slurpfile data ${outsideFile} . ${shellQuote(join(currentDir, "inside.txt"))}`).length, 1);
});

test("允许远程 URL 和 shell 设备路径", () => {
  assert.deepEqual(violations("curl https://example.com/api"), []);
  assert.deepEqual(violations("echo ok > /dev/null"), []);
  assert.deepEqual(violations("echo ok > /dev/stdout"), []);
  assert.deepEqual(violations("echo ok > /dev/fd/1"), []);
});

test("阻断内联目录选项和家目录路径", () => {
  assert.equal(violations(`git --git-dir=${shellQuote(join(outsideDir, ".git"))} status`).length, 1);
  assert.equal(violations(`env -C${shellQuote(outsideDir)} pwd`).length, 1);
  assert.equal(violations("ls ~/Downloads").length, 1);
});

test("允许 skills 目录路径，并放行单独执行 skill 脚本的项目参数", () => {
  const skillRoot = join(homedir(), ".agents", "skills");
  const skillScript = join(skillRoot, "development", "idea", "scripts", "verify-project-path.sh");
  const projectPath = join(outsideDir, "project");

  assert.deepEqual(violations(`cat ${shellQuote(join(skillRoot, "README.md"))}`), []);
  assert.deepEqual(violations(`${shellQuote(skillScript)} -p ${shellQuote(projectPath)} --fix`), []);
  assert.ok(violations(`${shellQuote(skillScript)} -p ${shellQuote(projectPath)} --fix && cat ${shellQuote(join(outsideDir, "secret.txt"))}`).length > 0);
});

test("目录越界和解析失败只返回简短说明", () => {
  type ToolCallHandler = (
    event: { toolName: string; input: Record<string, unknown> },
    ctx: { cwd: string; sessionManager: { getBranch(): unknown[] } },
  ) => unknown;
  let handler: ToolCallHandler | undefined;
  const fakePi = {
    /** 捕获扩展注册的 tool_call 回调，供测试直接调用。 */
    on(eventName: string, callback: unknown) {
      if (eventName === "tool_call") handler = callback as ToolCallHandler;
    },
  } as unknown as ExtensionAPI;
  bashDirectoryScope(fakePi);
  assert.ok(handler);

  const result = handler(
    { toolName: "bash", input: { command: `cat ${shellQuote(join(outsideDir, "secret.txt"))}` } },
    { cwd: currentDir, sessionManager: { getBranch: () => [] } },
  );
  assert.deepEqual(result, { block: true, reason: i18n.t("bashScopeBlocked") });
  assert.equal(JSON.stringify(result).includes(outsideDir), false);

  const parseErrorResult = handler(
    { toolName: "bash", input: { command: "echo \"unterminated" } },
    { cwd: currentDir, sessionManager: { getBranch: () => [] } },
  );
  assert.deepEqual(parseErrorResult, {
    block: true,
    reason: i18n.t(SHELL_PARSE_BLOCKED_MESSAGE_KEY),
  });
});

test("从活动分支最后一条 add-dir:state 读取目录", () => {
  const entries = [
    {
      type: "custom",
      customType: "add-dir:state",
      data: { dirs: [{ absolutePath: outsideDir }] },
    },
    { type: "message", message: {} },
    {
      type: "custom",
      customType: "add-dir:state",
      data: { dirs: [{ absolutePath: addedDir }, { absolutePath: "relative-dir" }] },
    },
  ];

  assert.deepEqual(addedDirectoryPathsFromBranch(entries), [addedDir]);
});
