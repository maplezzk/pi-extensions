import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJudgmentFindings,
  buildJudgmentQuestions,
  buildLocalizationQuestions,
  compileJudgments,
  extractChangedLines,
  MAX_LOCALIZATION_CANDIDATES,
  readJudgmentVerdicts,
  readLocatedLines,
  type RuleJudgment,
} from "../src/judgment.ts";
import { loadReviewRules, type FileEditReviewRule } from "../src/review-utils.ts";

process.env.PI_EXTENSIONS_LOCALE = "zh-CN";

const SWALLOWED_ERROR_RULE = `---
name: no-swallowed-error
severity: error
threshold: 0.9
---
# 不得静默吞掉异常

## 判据
true: 新增行捕获错误后静默继续
  包括空 catch 和用默认值掩盖失败
false: 通过抛出或记录日志报告失败

## 修复提示
把失败显式抛给调用方，不要用默认值掩盖。
`;

/** 把规则文件写到临时目录，再走真实的加载路径，避免测试直接构造 FileEditReviewRule。 */
async function loadRules(files: { name: string; content: string }[]): Promise<FileEditReviewRule[]> {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-judgment-"));
  const paths: string[] = [];
  for (const file of files) {
    const path = join(directory, file.name);
    await writeFile(path, file.content);
    paths.push(path);
  }
  const loaded = loadReviewRules({ name: "reviewer", model: "provider/model", rulesFiles: paths }, directory, 1000);
  assert.deepEqual(loaded.errors, []);
  return loaded.rules;
}

async function compileOne(content: string): Promise<RuleJudgment> {
  const rules = await loadRules([{ name: "rule.md", content }]);
  const compiled = compileJudgments(rules);
  assert.deepEqual(compiled.errors, []);
  assert.equal(compiled.judgments.length, 1);
  return compiled.judgments[0]!;
}

test("解析「## 判据」和「## 修复提示」，含缩进续行", async () => {
  const judgment = await compileOne(SWALLOWED_ERROR_RULE);

  assert.equal(judgment.id, "no-swallowed-error");
  assert.equal(judgment.severity, "error");
  assert.equal(judgment.threshold, 0.9);
  assert.match(judgment.criterionTrue, /静默继续 包括空 catch 和用默认值掩盖失败/);
  assert.match(judgment.criterionFalse, /通过抛出或记录日志报告失败/);
  assert.equal(judgment.fixHint, "把失败显式抛给调用方，不要用默认值掩盖。");
});

test("没有 front matter 的 severity 和 threshold 时使用默认值", async () => {
  const judgment = await compileOne(`# 规则\n\n## 判据\ntrue: 违反\nfalse: 未违反\n`);

  assert.equal(judgment.severity, "error");
  assert.equal(judgment.threshold, 0.85);
  // id 回退到文件名，避免所有无名规则共用一个标识。
  assert.equal(judgment.id, "rule");
  assert.equal(judgment.fixHint, undefined);
});

test("severity 和 threshold 非法时回退到默认值并给出警告", async () => {
  const rules = await loadRules([{
    name: "rule.md",
    content: `---\nname: broken\nseverity: fatal\nthreshold: 3\n---\n\n## 判据\ntrue: 违反\nfalse: 未违反\n`,
  }]);

  assert.match(rules[0]?.warning ?? "", /severity/);
  assert.match(rules[0]?.warning ?? "", /threshold/);
  const judgment = compileJudgments(rules).judgments[0];
  assert.equal(judgment?.severity, "error");
  assert.equal(judgment?.threshold, 0.85);
});

test("缺少判据的规则报成编译错误，而不是退回散文规则", async () => {
  const rules = await loadRules([{ name: "prose.md", content: "# 只有散文规则\n\n1. 不要吞异常。\n" }]);
  const compiled = compileJudgments(rules);

  assert.deepEqual(compiled.judgments, []);
  assert.equal(compiled.errors.length, 1);
  assert.match(compiled.errors[0]?.message ?? "", /判据/);
});

test("判断标识重复时去重并警告", async () => {
  const rules = await loadRules([
    { name: "first.md", content: `---\nname: shared\n---\n\n## 判据\ntrue: 违反\ntrue: 违反\nfalse: 未违反\n` },
    { name: "second.md", content: `---\nname: shared\n---\n\n## 判据\ntrue: 违反\nfalse: 未违反\n` },
  ]);
  const compiled = compileJudgments(rules);

  assert.deepEqual(compiled.judgments.map((judgment) => judgment.id), ["shared", "shared_2"]);
  assert.equal(compiled.warnings.length, 1);
  assert.match(compiled.warnings[0] ?? "", /shared_2/);
});

test("阈值和 severity 一起决定是否阻断", async () => {
  const judgment = await compileOne(SWALLOWED_ERROR_RULE);
  const advisory: RuleJudgment = { ...judgment, id: "advisory", severity: "warning", threshold: 0.5 };

  const { verdicts, unanswered } = readJudgmentVerdicts([judgment, advisory], {
    [judgment.id]: { type: "noul", noul: 0.9 },
    advisory: { type: "noul", noul: 0.6 },
  });

  assert.deepEqual(unanswered, []);
  // error 级命中即阻断；warning 级即使超过阈值也只提示。
  assert.deepEqual(verdicts.map((verdict) => [verdict.hit, verdict.blocking]), [[true, true], [true, false]]);
});

test("noul 低于阈值和缺答案分别是未命中和无法判定", async () => {
  const judgment = await compileOne(SWALLOWED_ERROR_RULE);
  const { verdicts, unanswered } = readJudgmentVerdicts([judgment], { [judgment.id]: { type: "noul", noul: 0.89 } });

  assert.equal(verdicts[0]?.hit, false);
  assert.equal(verdicts[0]?.blocking, false);
  assert.deepEqual(unanswered, []);

  const missing = readJudgmentVerdicts([judgment], {});
  assert.deepEqual(missing.verdicts, []);
  // 缺答案必须能被调用方识别为失败，不能默认通过。
  assert.deepEqual(missing.unanswered.map((entry) => entry.id), [judgment.id]);
});

test("判断问题引用 diff，并把判据放进 criteria", async () => {
  const judgment = await compileOne(SWALLOWED_ERROR_RULE);
  const questions = buildJudgmentQuestions([judgment]);
  const question = questions[judgment.id];

  assert.equal(question?.type, "noul");
  assert.match(question?.instructions ?? "", /`diff`/);
  assert.equal(question?.criteria.true, judgment.criterionTrue);
  assert.equal(question?.criteria.false, judgment.criterionFalse);
});

test("新增行扫描返回修改后文件的真实行号", async () => {
  const before = "const a = 1;\nconst b = 2;\n";
  const after = "const a = 1;\nconst b = 3;\nconst c = 4;\n";
  const scan = extractChangedLines(before, after);

  // 第 2 行是修改，第 3 行是新增；未改动的第 1 行不出现。
  assert.deepEqual(scan.lines, [{ line: 2, text: "const b = 3;" }, { line: 3, text: "const c = 4;" }]);
  assert.equal(scan.truncated, false);
});

test("没有修改前内容时整份文件都算新增行", async () => {
  const scan = extractChangedLines(undefined, "const a = 1;\nconst b = 2;\n");
  assert.deepEqual(scan.lines.map((candidate) => candidate.line), [1, 2]);
});

test("新增行超过上限时标记 truncated，调用方必须跳过定位", async () => {
  const after = Array.from({ length: MAX_LOCALIZATION_CANDIDATES + 5 }, (_value, index) => `const line${index} = 1;`).join("\n");
  const scan = extractChangedLines(undefined, `${after}\n`);

  assert.equal(scan.truncated, true);
  assert.equal(scan.lines.length, MAX_LOCALIZATION_CANDIDATES);
});

test("行定位问题按候选行给出选项，并保留 none 出口", async () => {
  const judgment = await compileOne(SWALLOWED_ERROR_RULE);
  const candidates = [{ line: 25, text: "} catch {" }, { line: 26, text: "  return null;" }];
  const questions = buildLocalizationQuestions([judgment], candidates);
  const question = questions[`${judgment.id}__line`];

  assert.equal(question?.type, "choice");
  assert.deepEqual(Object.keys(question?.criteria ?? {}), ["25", "26", "none"]);
  assert.match(question?.criteria["26"] ?? "", /第 26 行：/);
});

test("行定位在置信度不足或选择 none 时不返回行号", async () => {
  const judgment = await compileOne(SWALLOWED_ERROR_RULE);
  const candidates = [{ line: 25, text: "} catch {" }, { line: 26, text: "  return null;" }];
  const key = `${judgment.id}__line`;

  const located = readLocatedLines([judgment], {
    [key]: { type: "choice", choice: "26", confidence: 0.99 },
  }, candidates);
  assert.deepEqual(located.get(judgment.id), { line: 26, text: "  return null;" });

  const lowConfidence = readLocatedLines([judgment], {
    [key]: { type: "choice", choice: "26", confidence: 0.2 },
  }, candidates);
  assert.equal(lowConfidence.size, 0);

  const noLine = readLocatedLines([judgment], {
    [key]: { type: "choice", choice: "none", confidence: 0.99 },
  }, candidates);
  assert.equal(noLine.size, 0);
});

test("finding 使用规则自带的修复提示，并带上命中的真实行", async () => {
  const judgment = await compileOne(SWALLOWED_ERROR_RULE);
  const verdicts = [{ judgment, noul: 0.97, hit: true, blocking: true }];
  const located = new Map([[judgment.id, { line: 26, text: "  return null;" }]]);

  const findings = buildJudgmentFindings(verdicts, located);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "error");
  assert.equal(findings[0]?.ruleGroup, "no-swallowed-error");
  assert.equal(findings[0]?.line, 26);
  assert.match(findings[0]?.message ?? "", /把失败显式抛给调用方/);
  assert.match(findings[0]?.message ?? "", /命中代码：  return null;/);
});

test("没有修复提示时回退到判据描述", async () => {
  const judgment = await compileOne(`# 规则\n\n## 判据\ntrue: 新增行引入了魔法数字\nfalse: 没有引入\n`);
  const findings = buildJudgmentFindings([{ judgment, noul: 0.9, hit: true, blocking: true }], new Map());

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? "", /新增行引入了魔法数字/);
  assert.equal(findings[0]?.line, undefined);
});

test("未命中的判断不产生 finding", async () => {
  const judgment = await compileOne(SWALLOWED_ERROR_RULE);
  assert.deepEqual(buildJudgmentFindings([{ judgment, noul: 0.1, hit: false, blocking: false }], new Map()), []);
});

const MULTI_BLOCK_RULE = `---
name: javascript-typescript
severity: warning
threshold: 0.5
filePatterns:
  - "*.ts"
---
# JS/TS 代码质量

## 规则：no-magic-number
severity: error
threshold: 0.85

判据：
  true: 新增行在业务逻辑里直接写超时或限制类字面量，未提取为有语义常量
  false: 已提取为常量，或本次改动没有新增此类字面量

修复提示：把字面量提取成具名常量。

## 规则：no-swallowed-error
threshold: 0.9

## 判据
true: 新增行捕获错误后静默继续
false: 抛出、向上传递或记录日志

## 修复提示
把失败显式抛给调用方。
`;

/** 编译一个文件里的全部规则块，并断言没有编译错误。 */
async function compileAll(content: string): Promise<RuleJudgment[]> {
  const rules = await loadRules([{ name: "rule.md", content }]);
  const compiled = compileJudgments(rules);
  assert.deepEqual(compiled.errors, []);
  return compiled.judgments;
}

test("一个文件里的多个「## 规则：」块编译成多个独立判断", async () => {
  const judgments = await compileAll(MULTI_BLOCK_RULE);

  assert.deepEqual(judgments.map((judgment) => judgment.id), ["no-magic-number", "no-swallowed-error"]);
  assert.deepEqual(judgments.map((judgment) => judgment.ruleName), ["no-magic-number", "no-swallowed-error"]);
  // 两条规则共享同一个规则文件路径，但判据和修复提示互不串味。
  assert.equal(judgments[0]?.rulesFile, judgments[1]?.rulesFile);
  assert.match(judgments[0]?.criterionTrue ?? "", /超时或限制类字面量/);
  assert.doesNotMatch(judgments[0]?.criterionTrue ?? "", /静默继续/);
  assert.match(judgments[1]?.criterionTrue ?? "", /静默继续/);
  assert.equal(judgments[0]?.fixHint, "把字面量提取成具名常量。");
  assert.equal(judgments[1]?.fixHint, "把失败显式抛给调用方。");
});

test("块内 severity 和 threshold 覆盖 front matter，未覆盖的沿用文件级值", async () => {
  const judgments = await compileAll(MULTI_BLOCK_RULE);

  // 第一块写了两项：块内值生效。
  assert.equal(judgments[0]?.severity, "error");
  assert.equal(judgments[0]?.threshold, 0.85);
  // 第二块只写了 threshold，severity 回退到 front matter 的 warning。
  assert.equal(judgments[1]?.severity, "warning");
  assert.equal(judgments[1]?.threshold, 0.9);
});

test("每个规则块发一个独立的 Noul 问题，互不合并", async () => {
  const judgments = await compileAll(MULTI_BLOCK_RULE);
  const questions = buildJudgmentQuestions(judgments);

  assert.deepEqual(Object.keys(questions), ["no-magic-number", "no-swallowed-error"]);
  for (const judgment of judgments) {
    assert.equal(questions[judgment.id]?.type, "noul");
    assert.equal(questions[judgment.id]?.criteria.true, judgment.criterionTrue);
  }
});

test("某个规则块缺判据时只报该块的错误，其他块照常编译", async () => {
  const rules = await loadRules([{
    name: "rule.md",
    content: `# 规则\n\n## 规则：good\n\n## 判据\ntrue: 违反\nfalse: 未违反\n\n## 规则：broken\n\n## 修复提示\n没有判据。\n`,
  }]);
  const compiled = compileJudgments(rules);

  assert.deepEqual(compiled.judgments.map((judgment) => judgment.id), ["good"]);
  assert.equal(compiled.errors.length, 1);
  // 错误必须指明是哪个块，否则一个文件多规则时无法定位。
  assert.match(compiled.errors[0]?.message ?? "", /broken/);
});

test("文件同时有分块和顶层判据时忽略顶层判据并给出警告", async () => {
  const rules = await loadRules([{
    name: "rule.md",
    content: `# 规则\n\n## 判据\ntrue: 顶层判据\nfalse: 未违反\n\n## 规则：blocked\n\n## 判据\ntrue: 块内判据\nfalse: 未违反\n`,
  }]);

  assert.match(rules[0]?.warning ?? "", /顶层判据/);
  const judgments = compileJudgments(rules).judgments;
  assert.deepEqual(judgments.map((judgment) => judgment.id), ["blocked"]);
  assert.equal(judgments[0]?.criterionTrue, "块内判据");
});

test("「## 规则说明」这类普通标题不会被当成规则块", async () => {
  const judgments = await compileAll(`# 规则\n\n## 规则说明\n这里是散文说明。\n\n## 判据\ntrue: 违反\nfalse: 未违反\n`);

  assert.equal(judgments.length, 1);
  assert.equal(judgments[0]?.id, "rule");
  assert.equal(judgments[0]?.criterionTrue, "违反");
});

test("多个规则块重名时自动去重，并保留各自判据", async () => {
  const judgments = await compileAll(`# 规则\n\n## 规则：shared\n\n## 判据\ntrue: 第一个\nfalse: 未违反\n\n## 规则：shared\n\n## 判据\ntrue: 第二个\nfalse: 未违反\n`);

  assert.deepEqual(judgments.map((judgment) => judgment.id), ["shared", "shared_2"]);
  assert.deepEqual(judgments.map((judgment) => judgment.criterionTrue), ["第一个", "第二个"]);
});
