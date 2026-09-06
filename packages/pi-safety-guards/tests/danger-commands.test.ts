import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.ts";
import { compileRules, evaluateRules } from "../src/engine.ts";

const configured = compileRules(parseConfig({ rules: [
  { id: "shell.in-place", action: "block", match: { detector: "in-place-edit" } },
  { id: "paths.home", action: "block", match: { detector: "home-root" } },
  { id: "paths.root-search", action: "block", match: { detector: "root-search" } },
] }), tmpdir());

/** 从显式选择的规则中读取首个命中 ID。 */
async function matchedLabel(command: string): Promise<string | undefined> {
  return (await evaluateRules(await configured, command, tmpdir()))?.matches[0]?.id;
}

/** 断言既有 AST 检测范围未因策略分离而丢失。 */
async function assertMatches(command: string, expectedLabel: string): Promise<void> {
  assert.equal(await matchedLabel(command), expectedLabel, command);
}

/** 普通文本和查询不能被当成真实执行。 */
async function assertAllowed(command: string): Promise<void> {
  assert.equal(await matchedLabel(command), undefined, command);
}

test("按真实命令节点识别 rm/rmdir，放行普通参数和子命令", async () => {
  for (const command of [
    "rm -rf /tmp/example",
    "sudo -u root rm -rf /tmp/example",
    "/usr/bin/rm /tmp/example",
    "echo ready && rm /tmp/example",
    "bash -c 'rm /tmp/example'",
    "eval 'rm /tmp/example'",
    "echo \"$(rm /tmp/example)\"",
    "env -S 'rm /tmp/example'",
    "command -- rm /tmp/example",
  ]) {
    await assertMatches(command, "filesystem.delete");
  }
  await assertMatches("rmdir /tmp/empty", "filesystem.delete");

  for (const command of [
    "git rm tracked.txt",
    "npm rm package-name",
    "yarn rm package-name",
    "pnpm rm package-name",
    "bun rm package-name",
    "grep rm README.md",
    "echo 'rm /tmp/example'",
    "echo ok # rm /tmp/example",
    "command -v rm",
    "command -V rmdir",
    "command --help rm",
    "bash cleanup.sh -c 'rm /tmp/example'",
  ]) {
    await assertAllowed(command);
  }
});

test("识别 chown、mkfs 和 fork bomb，不宣称覆盖 chmod/dd", async () => {
  await assertMatches("chown root:root file", "filesystem.ownership");
  await assertMatches("env OWNER=root chown root file", "filesystem.ownership");
  await assertMatches("mkfs.ext4 /dev/sdb1", "filesystem.format");
  await assertMatches("/sbin/mkfs.xfs /dev/sdb1", "filesystem.format");
  await assertMatches(":(){ :|:& };:", "shell.fork-bomb");

  await assertAllowed("echo ':(){ :|:& };:'");
  await assertAllowed("chmod 755 script.sh");
  await assertAllowed("dd if=/dev/zero of=/tmp/out");
});

test("显式选择的检测器匹配 sed 原地修改", async () => {
  for (const command of [
    "sed -i 's/a/b/' file.txt",
    "sed -i.bak 's/a/b/' file.txt",
    "sed -ni 's/a/b/' file.txt",
    "sed --in-place 's/a/b/' file.txt",
    "sudo sed --in-place=.bak 's/a/b/' file.txt",
    "bash -c \"sed -i 's/a/b/' file.txt\"",
  ]) {
    await assertMatches(command, "shell.in-place");
  }

  for (const command of [
    "sed -n '1,10p' file.txt",
    "printf '%s\\n' 'sed -i is an example'",
    "git commit -m 'document sed -i usage'",
  ]) {
    await assertAllowed(command);
  }
});

test("区分未引用的 HOME 根目录与引号中的字面量", async () => {
  for (const command of ["ls ~", "find ~ -name '*.ts'", "cd ~", "tree ~"]) {
    await assertMatches(command, "paths.home");
  }

  for (const command of [
    "ls ~/project",
    "find ~/Documents -name '*.ts'",
    "echo '~'",
    "echo \"~\"",
  ]) {
    await assertAllowed(command);
  }
});

test("显式选择的检测器只匹配 find 的根目录参数", async () => {
  for (const command of [
    "find /",
    "sudo find / -maxdepth 1",
    "bash -c \"find / -name '*.ts'\"",
    "find '/' -type f",
  ]) {
    await assertMatches(command, "paths.root-search");
  }

  for (const command of [
    "find /tmp -name '*.ts'",
    "find . -name '*.ts'",
    "grep 'find /' README.md",
    "printf '%s\\n' 'find / is too broad'",
  ]) {
    await assertAllowed(command);
  }
});
