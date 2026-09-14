import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { describeEffectiveRules, describeMatch } from "../src/inspect.ts";
import { loadPresets } from "../src/presets.ts";

const catalog = loadPresets();

test("匹配器按配置文件里的字段名展示", () => {
  assert.equal(describeMatch({ commands: ["rm", "rmdir"] }), "commands: rm, rmdir");
  assert.equal(describeMatch({ commandPrefixes: ["mkfs"] }), "commandPrefixes: mkfs");
  assert.equal(describeMatch({ commandPattern: ":\\(\\)\\s*\\{" }), "commandPattern: :\\(\\)\\s*\\{");
  assert.equal(describeMatch({ outsideRoots: [] }), "outsideRoots: []");
  assert.equal(describeMatch({ module: "./rules/a.mjs" }), "module: ./rules/a.mjs");
});

test("生效规则按预设分组，并标注覆盖、停用和 rules 新增的条目", () => {
  const document = {
    presets: ["destructive-operations", "workspace-boundary"],
    rules: [
      { id: "filesystem.delete", action: "warn" },
      { id: "filesystem.format", enabled: false },
      { id: "local.maven", action: "block", match: { commands: ["mvn"] } },
    ],
  };
  const lines = describeEffectiveRules(document, catalog, parseConfig(document, catalog));
  const text = lines.join("\n");
  assert.match(text, /destructive-operations/);
  assert.match(text, /workspace-boundary/);
  assert.match(text, /filesystem\.delete → warn · commands: rm, rmdir/);
  assert.match(text, /(被 rules 覆盖|overridden by rules)/);
  assert.match(text, /filesystem\.format → (已停用|disabled)/);
  assert.match(text, /paths\.workspace → block · outsideRoots: \[\.\]/);
  assert.match(text, /local\.maven → block · commands: mvn/);
});

test("没有选中预设和规则时不输出内容", () => {
  const document = { presets: [], rules: [] };
  assert.deepEqual(describeEffectiveRules(document, catalog, parseConfig(document, catalog)), []);
});

test("只被停用的 rules 条目也算自定义条目并显示为停用", () => {
  const document = { presets: [], rules: [{ id: "local.maven", enabled: false, action: "block", match: { commands: ["mvn"] } }] };
  const lines = describeEffectiveRules(document, catalog, parseConfig(document, catalog));
  assert.match(lines.join("\n"), /local\.maven → (已停用|disabled)/);
});
