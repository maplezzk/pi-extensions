import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { DEFAULT_RULES, parseConfig } from "../src/config.ts";
import { compileRules, evaluateRules } from "../src/engine.ts";

/** 断言用的规则 ID；避免同一串 ID 在用例里散落。 */
const LABEL = {
  delete: "filesystem.delete",
  format: "filesystem.format",
  ownership: "filesystem.ownership",
  forkBomb: "shell.fork-bomb",
} as const;

/** fork bomb 的典型写法；分段拼接，避免手抄时多写或少写括号。 */
const FORK_BOMB = ":(){ :|:& };:";
/** 把 fork bomb 放进单引号后的命令文本，用于验证引号内文本也会命中。 */
const QUOTED_FORK_BOMB = `echo '${FORK_BOMB}'`;

const configured = compileRules(parseConfig({ rules: DEFAULT_RULES }), tmpdir());

/** 读取首个命中规则的 ID；命中顺序取决于配置里的规则顺序。 */
async function matchedLabel(command: string): Promise<string | undefined> {
  return (await evaluateRules(await configured, command, tmpdir()))?.matches[0]?.id;
}

/** 断言命令命中预期规则，失败信息带上命令原文。 */
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
    await assertMatches(command, LABEL.delete);
  }
  await assertMatches("rmdir /tmp/empty", LABEL.delete);

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

test("识别 chown、mkfs 前缀和 fork bomb，不宣称覆盖 chmod/dd", async () => {
  await assertMatches("chown root:root file", LABEL.ownership);
  await assertMatches("env OWNER=root chown root file", LABEL.ownership);
  await assertMatches("mkfs", LABEL.format);
  await assertMatches("mkfs.ext4 /dev/sdb1", LABEL.format);
  await assertMatches("/sbin/mkfs.xfs /dev/sdb1", LABEL.format);
  await assertMatches(FORK_BOMB, LABEL.forkBomb);

  await assertAllowed("chmod 755 script.sh");
  await assertAllowed("dd if=/dev/zero of=/tmp/out");
  await assertAllowed("git mkfs-helper /dev/sdb1");
});

test("引号内的 fork bomb 字面量同样会命中（正则看原始命令文本的取舍）", async () => {
  // detector 移除后不再用 AST 节点区分引号内容，这两条也会要求确认。
  await assertMatches(QUOTED_FORK_BOMB, LABEL.forkBomb);
  await assertMatches(`bash -c '${FORK_BOMB}'`, LABEL.forkBomb);
  await assertAllowed("echo fork bomb");
});
