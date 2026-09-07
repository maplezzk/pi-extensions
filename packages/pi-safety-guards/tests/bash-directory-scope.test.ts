import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  addedDirectoryPathsFromSession,
  findOutOfScopeBashPaths,
} from "../src/bash-directory-scope-utils.ts";
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
  return findOutOfScopeBashPaths(command, currentDir, [currentDir, ...externalDirectories]);
}

test("允许当前目录内的相对路径和绝对路径", () => {
  assert.deepEqual(violations("git status"), []);
  assert.deepEqual(violations("cat inside.txt"), []);
  assert.deepEqual(violations(`cat ${shellQuote(join(currentDir, "inside.txt"))}`), []);
});

test("允许明确提供的额外目录及其后代", () => {
  assert.deepEqual(violations(`git -C ${shellQuote(addedDir)} status`, [addedDir]), []);
  assert.deepEqual(violations(`cat ${shellQuote(join(addedDir, "added.txt"))}`, [addedDir]), []);
});

test("不默认信任 /tmp、/var，只有显式 roots 才放行", () => {
  assert.equal(violations("ls /tmp").length, 1);
  assert.equal(violations("cat /var/tmp/input.txt").length, 1);
  assert.deepEqual(violations("cat /tmp/input.txt", ["/tmp"]), []);
  assert.equal(violations("cat /tmp-other/secret.txt", ["/tmp"]).length, 1);
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

test("远程 URL 不视为本地路径，设备路径也须显式允许", () => {
  assert.deepEqual(violations("curl https://example.com/api"), []);
  assert.deepEqual(violations("echo ok > /dev/null", ["/dev/null"]), []);
  assert.deepEqual(violations("echo ok > /dev/stdout", ["/dev/stdout"]), []);
  assert.deepEqual(violations("echo ok > /dev/fd/1", ["/dev/fd"]), []);
});

test("阻断内联目录选项和家目录路径", () => {
  assert.equal(violations(`git --git-dir=${shellQuote(join(outsideDir, ".git"))} status`).length, 1);
  assert.equal(violations(`env -C${shellQuote(outsideDir)} pwd`).length, 1);
  assert.equal(violations("ls ~/Downloads").length, 1);
});

test("session_squash 后从原分支恢复 add_directory 白名单", () => {
  const state = {
    type: "custom",
    id: "state-1",
    parentId: "user-1",
    customType: "add-dir:state",
    data: { dirs: [{ absolutePath: addedDir }] },
  };
  const sourceLeaf = {
    type: "message",
    id: "leaf-1",
    parentId: "state-1",
    message: { role: "assistant", content: [] },
  };
  const squash = {
    type: "custom_message",
    id: "squash-1",
    parentId: "user-1",
    customType: "session-squash",
    content: "handoff",
    details: { sourceLeafId: "leaf-1" },
  };
  const activeBranch = [
    { type: "session", id: "header" },
    { type: "message", id: "user-1", parentId: null, message: { role: "user", content: [] } },
    squash,
  ];

  assert.deepEqual(
    addedDirectoryPathsFromSession([state, sourceLeaf, squash], activeBranch),
    [addedDir],
  );
  assert.deepEqual(
    findOutOfScopeBashPaths(`cat ${shellQuote(join(addedDir, "added.txt"))}`, currentDir,
      addedDirectoryPathsFromSession([state, sourceLeaf, squash], activeBranch)),
    [],
  );
});

test("squash checkpoint 按时序覆盖 checkpoint 之前的旧状态", () => {
  const oldState = {
    type: "custom", id: "state-old", parentId: "user-1", customType: "add-dir:state",
    data: { dirs: [{ absolutePath: outsideDir }] },
  };
  const sourceState = {
    type: "custom", id: "state-source", parentId: "leaf-1", customType: "add-dir:state",
    data: { dirs: [{ absolutePath: addedDir }] },
  };
  const sourceLeaf = { type: "message", id: "leaf-1", parentId: "state-old", message: {} };
  const squash = {
    type: "custom_message", id: "squash-1", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "state-source" }, content: "handoff",
  };

  assert.deepEqual(
    addedDirectoryPathsFromSession([oldState, sourceLeaf, sourceState, squash], [oldState, squash]),
    [addedDir],
  );
});

test("连续 squash 递归解析前一个 squash 的 sourceLeaf", () => {
  const state = {
    type: "custom", id: "state-1", parentId: "user-1", customType: "add-dir:state",
    data: { dirs: [{ absolutePath: addedDir }] },
  };
  const sourceLeaf1 = { type: "message", id: "leaf-1", parentId: "state-1", message: {} };
  const squash1 = {
    type: "custom_message", id: "squash-1", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "leaf-1" }, content: "handoff-1",
  };
  const sourceLeaf2 = { type: "message", id: "leaf-2", parentId: "squash-1", message: {} };
  const squash2 = {
    type: "custom_message", id: "squash-2", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "leaf-2" }, content: "handoff-2",
  };

  assert.deepEqual(
    addedDirectoryPathsFromSession([state, sourceLeaf1, squash1, sourceLeaf2, squash2], [squash2]),
    [addedDir],
  );
});

test("squash source 环路不会递归或复活旧授权", () => {
  const state = {
    type: "custom", id: "state-cycle", parentId: "user-1", customType: "add-dir:state",
    data: { dirs: [{ absolutePath: addedDir }] },
  };
  const squashA = {
    type: "custom_message", id: "squash-a", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "leaf-b" }, content: "a",
  };
  const leafB = { type: "message", id: "leaf-b", parentId: "squash-a", message: {} };
  const squashB = {
    type: "custom_message", id: "squash-b", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "leaf-a" }, content: "b",
  };
  const leafA = { type: "message", id: "leaf-a", parentId: "squash-b", message: {} };

  assert.deepEqual(
    addedDirectoryPathsFromSession([state, squashA, leafB, squashB, leafA], [state, squashA]),
    [],
  );
});

test("显式 cycle 和 squash 后新 add_directory 状态覆盖旧授权", () => {
  const oldState = {
    type: "custom", id: "state-old", parentId: "user-1", customType: "add-dir:state",
    data: { dirs: [{ absolutePath: outsideDir }] },
  };
  const squash = {
    type: "custom_message", id: "squash", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "leaf" }, content: "cycle",
  };
  const leaf = { type: "message", id: "leaf", parentId: "squash", message: {} };
  const activeState = {
    type: "custom", id: "state-new", parentId: "squash", customType: "add-dir:state",
    data: { dirs: [{ absolutePath: addedDir }] },
  };
  assert.deepEqual(
    addedDirectoryPathsFromSession([oldState, squash, leaf, activeState], [oldState, squash, activeState]),
    [addedDir],
  );
  assert.deepEqual(
    addedDirectoryPathsFromSession([oldState, squash, leaf], [oldState, squash]),
    [],
  );
});

test("空目录状态明确撤销授权，缺失 source 不回退旧授权", () => {
  const state = {
    type: "custom", id: "state-1", parentId: "user-1", customType: "add-dir:state",
    data: { dirs: [{ absolutePath: addedDir }] },
  };
  const sourceLeaf = { type: "message", id: "leaf-1", parentId: "state-1", message: {} };
  const clearState = {
    type: "custom", id: "state-clear", parentId: "leaf-1", customType: "add-dir:state",
    data: { dirs: [] },
  };
  const squashWithClear = {
    type: "custom_message", id: "squash-clear", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "state-clear" }, content: "clear",
  };
  const squashWithMissingSource = {
    type: "custom_message", id: "squash-missing", parentId: "user-1", customType: "session-squash",
    details: { sourceLeafId: "missing-leaf" }, content: "missing",
  };

  assert.deepEqual(
    addedDirectoryPathsFromSession([state, sourceLeaf, clearState, squashWithClear], [squashWithClear]),
    [],
  );
  assert.deepEqual(
    addedDirectoryPathsFromSession([state, squashWithMissingSource], [state, squashWithMissingSource]),
    [],
  );
});

test("不隐式信任 skills，也不豁免脚本参数", () => {
  const skillRoot = join(homedir(), ".agents", "skills");
  const script = join(skillRoot, "example", "verify.sh");
  assert.equal(violations(`cat ${shellQuote(join(skillRoot, "SKILL.md"))}`).length, 1);
  assert.deepEqual(violations(`cat ${shellQuote(join(skillRoot, "SKILL.md"))}`, [skillRoot]), []);
  assert.equal(violations(`${shellQuote(script)} ${shellQuote(outsideDir)}`, [skillRoot]).length, 1);
});

test("允许根可以是相对 cwd 的路径，不隐式加入 cwd", () => {
  assert.deepEqual(findOutOfScopeBashPaths("cat ../added/added.txt", currentDir, ["../added"]), []);
  assert.equal(findOutOfScopeBashPaths("cat inside.txt", currentDir, ["../added"]).length, 1);
});

test("失效符号链接不能被静默当成允许范围内的普通路径", () => {
  symlinkSync(join(outsideDir, "missing-target"), join(currentDir, "dangling-link"));
  assert.throws(() => violations("cat dangling-link"));
});
