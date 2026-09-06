import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config.ts";
import type { RuleContext } from "../src/types.ts";
import { compileRules, evaluateRules } from "../src/engine.ts";

/** 在无私有文件和终端依赖的上下文中评估配置。 */
async function evaluate(config: unknown, command: string) {
  return evaluateRules(await compileRules(parseConfig(config), tmpdir()), command, tmpdir());
}

test("默认预设确认危险操作，不限制技术栈、编辑方式和范围", async () => {
  for (const command of ["rm file", "rmdir empty", "mkfs.ext4 /dev/example", "chown owner file", ":(){ :|:& };:"]) {
    assert.equal((await evaluate({}, command))?.action, "confirm", command);
  }
  for (const command of ["mvn test", "npm test", "pip install example", "sed -i 's/a/b/' file", "ls ~", "find /", "cat /outside/file"]) {
    assert.equal(await evaluate({}, command), undefined, command);
  }
});

test("同一检测器可以改为 warn/block 或关闭，不执行任何替代工具", async () => {
  for (const action of ["warn", "block"]) {
    assert.equal((await evaluate({ rules: [{ id: "filesystem.delete", action }] }, "rm file"))?.action, action);
  }
  assert.equal(await evaluate({ rules: [{ id: "filesystem.delete", enabled: false }] }, "rm file"), undefined);
});

test("block 优先于 confirm 和 warn，与规则出现顺序无关", async () => {
  for (const actions of [["warn", "confirm", "block"], ["block", "confirm", "warn"]]) {
    const config = { presets: [], rules: actions.map((action) => ({ id: action, action, match: { commands: ["example"] } })) };
    const decision = await evaluate(config, "example");
    assert.equal(decision?.action, "block");
    assert.equal(decision?.matches.length, 3);
  }
});

test("可以按相同配置格式限制任意构建工具，不只 Maven", async () => {
  for (const command of ["mvn", "npm", "python", "custom-build"]) {
    const config = { presets: [], rules: [{ id: "team-build", action: "block", match: { commands: [command] } }] };
    assert.equal((await evaluate(config, `env X=1 ${command} build`))?.action, "block");
    assert.equal(await evaluate(config, `echo '${command} build'`), undefined);
  }
});

test("显式选择目录预设才限制路径，允许范围可覆盖", async () => {
  const cwd = join(tmpdir(), "policy-cwd");
  const blocked = await compileRules(parseConfig({ presets: ["workspace-boundary"] }), tmpdir());
  assert.equal((await evaluateRules(blocked, "cat ../outside/file", cwd))?.action, "block");
  const overridden = await compileRules(parseConfig({ presets: ["workspace-boundary"], rules: [{ id: "paths.workspace", match: { outsideRoots: [".", "../outside"] } }] }), tmpdir());
  assert.equal(await evaluateRules(overridden, "cat ../outside/file", cwd), undefined);
});

test("只加载显式启用的本地规则模块，配置目录决定相对路径", async () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-module-"));
  writeFileSync(join(dir, "rule.mjs"), 'export default ({ commands }) => commands.some(c => c.name === "special");');
  const config = parseConfig({ presets: [], rules: [{ id: "custom", action: "confirm", match: { module: "./rule.mjs" } }] });
  const compiled = await compileRules(config, dir);
  assert.equal((await evaluateRules(compiled, "special", dir))?.action, "confirm");
  assert.equal(await evaluateRules(compiled, "echo special", dir), undefined);
  const disabled = parseConfig({ presets: [], rules: [{ id: "custom", enabled: false, match: { module: "./missing.mjs" } }] });
  assert.deepEqual(await compileRules(disabled, dir, async () => assert.fail("disabled module was loaded")), []);
});

test("模块上下文是不可变摘要，异常和非布尔返回均带规则 ID", async () => {
  const config = parseConfig({ presets: [], rules: [{ id: "custom", action: "block", match: { module: "./rule.mjs" } }] });
  const compiled = await compileRules(config, tmpdir(), async () => ({ default: (ctx: RuleContext) => {
    assert.equal(Object.isFrozen(ctx), true);
    assert.equal(Object.isFrozen(ctx.commands[0].args), true);
    return "not a boolean";
  } }));
  await assert.rejects(evaluateRules(compiled, "example arg", tmpdir()), /custom/);
  const broken = await compileRules(config, tmpdir(), async () => ({ default: () => { throw new Error("broken matcher"); } }));
  await assert.rejects(evaluateRules(broken, "example", tmpdir()), /custom.*broken matcher/);
  await assert.rejects(compileRules(config, tmpdir(), async () => { throw new Error("missing module"); }), /custom.*missing module/);
  await assert.rejects(compileRules(config, tmpdir(), async () => ({ default: 1 })), /custom/);
});

test("异步模块超时阻断而不是无限等待", async () => {
  const config = parseConfig({ presets: [], rules: [{ id: "slow-rule", action: "warn", match: { module: "./slow.mjs" } }] });
  const rules = await compileRules(config, tmpdir(), async () => ({ default: () => new Promise(() => {}) }));
  await assert.rejects(evaluateRules(rules, "example", tmpdir()), /slow-rule/);
});

test("启用保护后解析失败显式报错，全部关闭则不解析", async () => {
  await assert.rejects(evaluate({}, 'echo "unterminated'), /解析|parsed/);
  assert.equal(await evaluate({ presets: [] }, 'echo "unterminated'), undefined);
});
