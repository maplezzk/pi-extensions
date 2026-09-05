import assert from "node:assert/strict";
import { test } from "node:test";
import { findDangerRule } from "../src/danger-utils.ts";

/** 返回命令首个匹配的危险规则标签，无匹配时返回 undefined。 */
function matchedLabel(command: string): string | undefined {
  return findDangerRule(command)?.label;
}

/** 断言命令匹配指定危险规则。 */
function assertMatches(command: string, expectedLabel: string): void {
  assert.equal(matchedLabel(command), expectedLabel, command);
}

/** 断言命令未匹配任何危险规则。 */
function assertAllowed(command: string): void {
  assert.equal(matchedLabel(command), undefined, command);
}

test("按真实命令节点识别 rm/rmdir，放行普通参数和子命令", () => {
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
    assertMatches(command, "rm（删除文件/目录）");
  }
  assertMatches("rmdir /tmp/empty", "rmdir（删除空目录）");

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
    assertAllowed(command);
  }
});

test("识别 chown、mkfs 和 fork bomb，保留 chmod/dd 放行策略", () => {
  assertMatches("chown root:root file", "chown（修改所有者）");
  assertMatches("env OWNER=root chown root file", "chown（修改所有者）");
  assertMatches("mkfs.ext4 /dev/sdb1", "mkfs（格式化磁盘）");
  assertMatches("/sbin/mkfs.xfs /dev/sdb1", "mkfs（格式化磁盘）");
  assertMatches(":(){ :|:& };:", "Fork 炸弹");

  assertAllowed("echo ':(){ :|:& };:'");
  assertAllowed("chmod 755 script.sh");
  assertAllowed("dd if=/dev/zero of=/tmp/out");
});

test("仅阻断实际执行的 sed 原地修改", () => {
  for (const command of [
    "sed -i 's/a/b/' file.txt",
    "sed -i.bak 's/a/b/' file.txt",
    "sed -ni 's/a/b/' file.txt",
    "sed --in-place 's/a/b/' file.txt",
    "sudo sed --in-place=.bak 's/a/b/' file.txt",
    "bash -c \"sed -i 's/a/b/' file.txt\"",
  ]) {
    assertMatches(command, "sed -i（原地修改文件）");
  }

  for (const command of [
    "sed -n '1,10p' file.txt",
    "printf '%s\\n' 'sed -i is an example'",
    "git commit -m 'document sed -i usage'",
  ]) {
    assertAllowed(command);
  }
});

test("区分未引用的 HOME 根目录与引号中的字面量", () => {
  for (const command of ["ls ~", "find ~ -name '*.ts'", "cd ~", "tree ~"]) {
    assertMatches(command, "直接搜索 ~ 目录");
  }

  for (const command of [
    "ls ~/project",
    "find ~/Documents -name '*.ts'",
    "echo '~'",
    "echo \"~\"",
  ]) {
    assertAllowed(command);
  }
});

test("仅在 find 的真实参数为根目录时阻断全盘搜索", () => {
  for (const command of [
    "find /",
    "sudo find / -maxdepth 1",
    "bash -c \"find / -name '*.ts'\"",
    "find '/' -type f",
  ]) {
    assertMatches(command, "find /（全盘搜索）");
  }

  for (const command of [
    "find /tmp -name '*.ts'",
    "find . -name '*.ts'",
    "grep 'find /' README.md",
    "printf '%s\\n' 'find / is too broad'",
  ]) {
    assertAllowed(command);
  }
});
