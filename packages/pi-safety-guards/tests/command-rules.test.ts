import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.ts";
import { compileRules, evaluateRules } from "../src/engine.ts";

// 技术栈名称仅作为用户规则数据，不进入公共默认规则。
const rules = compileRules(parseConfig({ presets: [], rules: [{
  id: "custom.command", action: "block",
  match: { commands: ["mvn", "mvnw", "mvnDebug", "mvnd", "maven"] },
}] }), tmpdir());

/** 通用命令匹配器复现用户构建工具策略。 */
async function assertMaven(command: string, expected: boolean): Promise<void> {
  assert.equal(Boolean(await evaluateRules(await rules, command, tmpdir())), expected, command);
}

test("识别直接调用、路径形式和组合命令中的 Maven", async () => {
  for (const command of [
    "mvn verify",
    "./mvnw test",
    "mvnDebug compile",
    "mvnd package",
    "maven -version",
    "/opt/maven/bin/mvn dependency:tree",
    "pwd && mvn test",
    "echo ok; ./mvnw test",
    "echo ok | mvn -version",
  ]) {
    await assertMaven(command, true);
  }
});

test("识别 wrapper 和嵌套 Shell 中实际执行的 Maven", async () => {
  for (const command of [
    "sudo -u build mvn test",
    "env JAVA_HOME=/opt/jdk mvn verify",
    "command -- ./mvnw test",
    "nohup mvnd test",
    "exec mvn package",
    "bash -c 'mvn test'",
    "sh -lc './mvnw verify'",
    "eval 'mvn test'",
    "echo \"$(mvn -version)\"",
    "env -S 'mvn test'",
    "env --split-string='./mvnw verify'",
  ]) {
    await assertMaven(command, true);
  }
});

test("放行普通文本、查询命令和验证脚本", async () => {
  for (const command of [
    "npm install",
    "echo mavenized",
    "grep mvn README.md",
    "echo 'mvn test'",
    "echo ok # mvn test",
    "echo $MAVEN_OPTS",
    "ls .mvn",
    "command -v mvn",
    "command -V mvnw",
    "command --help mvn",
    "bash build.sh -c 'mvn test'",
    "bash \"$SKILL_ROOT/scripts/mvn-verify.sh\" /path/to/project",
  ]) {
    await assertMaven(command, false);
  }
});
