import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeShellCommand } from "../src/shell-command-utils.ts";

test("统一解析 wrapper、真实命令和 shell -c 子命令", () => {
  const analysis = analyzeShellCommand(
    "sudo -D/out env FOO=bar bash -c 'mvn test'",
  );

  assert.deepEqual(analysis.commands.map(({ name }) => name), ["bash", "mvn"]);
  assert.deepEqual(analysis.wrappers.map(({ name }) => name), ["sudo", "env"]);
  assert.deepEqual(analysis.wrappers[0].options, [{ name: "-D", value: "/out" }]);
  assert.equal(analysis.commands[0].nestedSource, "mvn test");
});

test("解析 env split-string 与 eval 的字面量子命令", () => {
  assert.deepEqual(
    analyzeShellCommand("env --split-string='rm /tmp/example'").commands.map(({ name }) => name),
    ["rm"],
  );
  assert.deepEqual(
    analyzeShellCommand("eval 'mvn test'").commands.map(({ name }) => name),
    ["eval", "mvn"],
  );
});

test("遍历命令替换但不解释单引号中的普通文本", () => {
  assert.deepEqual(
    analyzeShellCommand('echo "$(id)"').commands.map(({ name }) => name),
    ["echo", "id"],
  );
  assert.deepEqual(
    analyzeShellCommand("echo '$(id)'").commands.map(({ name }) => name),
    ["echo"],
  );
});

test("shell -c 只在脚本文件参数之前作为解释选项", () => {
  assert.deepEqual(
    analyzeShellCommand("bash -O extglob -c 'mvn test'").commands.map(({ name }) => name),
    ["bash", "mvn"],
  );
  assert.deepEqual(
    analyzeShellCommand("bash script.sh -c 'mvn test'").commands.map(({ name }) => name),
    ["bash"],
  );
});

test("command 查询模式不会把查询目标识别为被执行命令", () => {
  assert.deepEqual(analyzeShellCommand("command -v rm").commands, []);
  assert.deepEqual(
    analyzeShellCommand("command -vff rm /tmp/example").commands.map(({ name }) => name),
    ["rm"],
  );
  assert.deepEqual(
    analyzeShellCommand("command -- rm /tmp/example").commands.map(({ name }) => name),
    ["rm"],
  );
});

test("保留 unbash 的语法错误供安全入口显式阻断", () => {
  const analysis = analyzeShellCommand("echo \"unterminated");
  assert.equal(analysis.errors.length, 1);
  assert.match(analysis.errors[0].message, /unterminated/i);
});
