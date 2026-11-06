import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { describeEffectiveRules, describeMatch } from "../src/inspect.ts";

test("匹配器按配置文件里的字段名展示", () => {
  assert.equal(describeMatch({ commands: ["rm", "rmdir"] }), "commands: rm, rmdir");
  assert.equal(describeMatch({ commandPrefixes: ["mkfs"] }), "commandPrefixes: mkfs");
  assert.equal(describeMatch({ commandPattern: ":\\(\\)\\s*\\{" }), "commandPattern: :\\(\\)\\s*\\{");
  assert.equal(describeMatch({ outsideRoots: [] }), "outsideRoots: []");
  assert.equal(describeMatch({ module: "./rules/a.mjs" }), "module: ./rules/a.mjs");
});

test("生效规则按配置文件顺序列出，停用的标注状态", () => {
  const document = {
    rules: [
      { id: "filesystem.delete", action: "confirm", match: { commands: ["rm"] } },
      { id: "local.maven", enabled: false, action: "block", match: { commands: ["mvn"] } },
      { id: "paths.workspace", action: "block", match: { outsideRoots: ["."] } },
    ],
  };
  const text = describeEffectiveRules(document, parseConfig(document)).join("\n");
  assert.match(text, /filesystem\.delete → confirm · commands: rm/);
  assert.match(text, /local\.maven → (已停用|disabled)/);
  assert.match(text, /paths\.workspace → block · outsideRoots: \[\.\]/);
});

test("没有规则时不输出内容", () => {
  const document = { rules: [] };
  assert.deepEqual(describeEffectiveRules(document, parseConfig(document)), []);
});

test("只被停用的规则也算一条并显示为停用", () => {
  const document = { rules: [{ id: "local.maven", enabled: false, action: "block", match: { commands: ["mvn"] } }] };
  const lines = describeEffectiveRules(document, parseConfig(document));
  assert.deepEqual(lines.length, 1);
  assert.match(lines[0] ?? "", /local\.maven → (已停用|disabled)/);
});
