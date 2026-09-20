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

/**
 * 刻意照抄用户真实规则文件的写法：front matter、元指令段落、编号条款、
 * 条款开头的历史级别标注、粗体标题、缩进续行。用来证明规则文件零改动可用。
 */
const RULE_FILE = `---
name: javascript-typescript
enabled: true
filePatterns:
  - "**/*.ts"
threshold: 0.8
---
# JavaScript / TypeScript 规则

只针对 diff 中新增或修改的代码报告问题。

## 归属与 severity（优先于以上条款）

1. \`ruleGroup\` 只能填本文件里原样出现的条款名或编号，例如「必须遵守 2」。
2. 禁止越界：不要报本文件没写的规则、其它 reviewer 的规则。
3. 禁止编造条款和自由发挥。

## 必须遵守

1. [error] **禁止魔法值**：业务逻辑中的非显而易见数字必须提取为有语义的 \`const\` 或集中配置。
2. [warning] **最多 3 个参数**：声明中出现 4 个或更多参数时必须改为参数对象。
3. **禁止 any**：优先使用具体类型；无法确定时使用 \`unknown\` 并在边界处收窄。
   不要用 \`as any\` 或 \`any[]\` 绕过类型检查。

## 判定要求

- 只报告本规则明确覆盖的问题，并给出规则编号、文件位置和简短修复建议。
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

async function compileAll(content: string): Promise<RuleJudgment[]> {
  const rules = await loadRules([{ name: "rules.md", content }]);
  const compiled = compileJudgments(rules);
  assert.deepEqual(compiled.errors, []);
  return compiled.judgments;
}

async function compileOne(content: string): Promise<RuleJudgment> {
  const judgments = await compileAll(content);
  assert.equal(judgments.length, 1);
  return judgments[0]!;
}

test("编号条款直接变成规则，条款正文既是判据也是修复提示", async () => {
  const judgments = await compileAll(RULE_FILE);

  assert.equal(judgments.length, 3);
  assert.deepEqual(judgments.map((judgment) => judgment.id), ["rule_1", "rule_2", "rule_3"]);
  assert.deepEqual(judgments.map((judgment) => judgment.ruleName), [
    "必须遵守 1 禁止魔法值",
    "必须遵守 2 最多 3 个参数",
    "必须遵守 3 禁止 any",
  ]);
  // 判据就是条款原文，没有额外写过任何 ## 判据 段落。
  assert.match(judgments[0]?.criterion ?? "", /业务逻辑中的非显而易见数字必须提取为有语义的/);
  assert.match(judgments[2]?.criterion ?? "", /优先使用具体类型/);
});

test("元指令段落里的编号不参与判断", async () => {
  const judgments = await compileAll(RULE_FILE);

  // 「归属…」段落里的编号讲的是怎么报告，不能变成代码规则。
  for (const judgment of judgments) {
    assert.doesNotMatch(judgment.criterion, /ruleGroup 只能填/);
    assert.doesNotMatch(judgment.criterion, /禁止越界/);
    assert.doesNotMatch(judgment.criterion, /禁止编造条款/);
  }
});

test("条款开头的历史级别标注被剔掉：本后端没有分级", async () => {
  const judgments = await compileAll(RULE_FILE);

  // [error] 和 [warning] 都不该出现在判据里，否则和行为矛盾。
  for (const judgment of judgments) {
    assert.doesNotMatch(judgment.criterion, /^\[(error|warning|info)\]/);
  }
  assert.match(judgments[0]?.criterion ?? "", /^\*\*禁止魔法值\*\*：/);
  assert.match(judgments[1]?.criterion ?? "", /^\*\*最多 3 个参数\*\*：/);
});

test("缩进续行拼进同一条款的判据", async () => {
  const judgments = await compileAll(RULE_FILE);

  assert.match(judgments[2]?.criterion ?? "", /不要用 `as any` 或 `any\[\]` 绕过类型检查。/);
});

test("阈值取自 front matter，未配置时用默认值", async () => {
  const withThreshold = await compileAll(RULE_FILE);
  assert.deepEqual(withThreshold.map((judgment) => judgment.threshold), [0.8, 0.8, 0.8]);

  const withoutThreshold = await compileAll("# 规则\n\n## 检查项\n\n1. **禁止 any**：不要用 any。\n");
  assert.deepEqual(withoutThreshold.map((judgment) => judgment.threshold), [0.85]);
});

test("切不出条款时报错指名文件，而不是静默通过", async () => {
  const rules = await loadRules([{
    name: "steps.md",
    content: "---\nname: steps\n---\n\n# 规则\n\n没有编号条款，只有散文。\n",
  }]);
  const compiled = compileJudgments(rules);

  assert.deepEqual(compiled.judgments, []);
  assert.equal(compiled.errors.length, 1);
  assert.match(compiled.errors[0]?.rulesFile ?? "", /steps\.md/);
  assert.match(compiled.errors[0]?.message ?? "", /编号条款/);
});

test("条款编号重复时去重并警告", async () => {
  const rules = await loadRules([{
    name: "dup.md",
    content: "---\nname: dup\n---\n\n## 检查项\n\n1. **第一条**：违反 A。\n\n1. **第二条**：违反 B。\n",
  }]);
  const compiled = compileJudgments(rules);

  assert.deepEqual(compiled.judgments.map((judgment) => judgment.id), ["rule_1", "rule_1_2"]);
  assert.equal(compiled.warnings.length, 1);
  assert.match(compiled.warnings[0] ?? "", /rule_1/);
});

test("多个规则文件合并时不重号，也不报重复编号警告", async () => {
  // 条款编号是文件内序号，每个文件都从 1 开始；合并成一次审查后跨文件必然重号。
  const rules = await loadRules([
    { name: "a.md", content: "# 规则 A\n\n## 检查项\n\n1. **禁止静默吞异常**：捕获后静默继续。\n" },
    { name: "b.md", content: "# 规则 B\n\n## 检查项\n\n1. **禁止魔法值**：提取为常量。\n2. **最多 3 个参数**：改为参数对象。\n" },
  ]);
  const compiled = compileJudgments(rules);

  assert.deepEqual(compiled.warnings, []);
  assert.deepEqual(compiled.judgments.map((judgment) => judgment.id), ["f1_rule_1", "f2_rule_1", "f2_rule_2"]);
  // 每个判断仍然指向自己的规则文件，前缀只解决 id 重号。
  assert.deepEqual(compiled.judgments.map((judgment) => judgment.rulesFile.split("/").pop()), ["a.md", "b.md", "b.md"]);
});

test("同一个文件里编号重复仍然警告", async () => {
  const rules = await loadRules([
    { name: "a.md", content: "# 规则 A\n\n## 检查项\n\n1. **禁止静默吞异常**：捕获后静默继续。\n" },
    { name: "b.md", content: "# 规则 B\n\n## 检查项\n\n1. **禁止魔法值**：提取为常量。\n\n1. **最多 3 个参数**：改为参数对象。\n" },
  ]);
  const compiled = compileJudgments(rules);

  assert.deepEqual(compiled.judgments.map((judgment) => judgment.id), ["f1_rule_1", "f2_rule_1", "f2_rule_1_2"]);
  assert.equal(compiled.warnings.length, 1);
  assert.match(compiled.warnings[0] ?? "", /b\.md/);
});

test("阈值决定命中；noul 低于阈值和缺答案是两回事", async () => {
  const judgments = await compileAll(RULE_FILE);

  const { verdicts, unanswered } = readJudgmentVerdicts(judgments, {
    rule_1: { type: "noul", noul: 0.97 },
    rule_2: { type: "noul", noul: 0.31 },
  });

  assert.deepEqual(verdicts.map((verdict) => [verdict.judgment.id, verdict.hit]), [["rule_1", true], ["rule_2", false]]);
  // rule_3 没有答案，必须报成无法判定而不是「未命中」。
  assert.deepEqual(unanswered.map((judgment) => judgment.id), ["rule_3"]);
});

test("非法 noul 也算无法判定", async () => {
  const judgment = await compileOne("## 检查项\n\n1. **禁止 any**：不要用 any。\n");
  const { verdicts, unanswered } = readJudgmentVerdicts([judgment], {
    [judgment.id]: { type: "noul", noul: Number.NaN },
  });

  assert.deepEqual(verdicts, []);
  assert.equal(unanswered.length, 1);
});

test("每条规则发一个 Noul 问题，条款原文进 criteria", async () => {
  const judgments = await compileAll(RULE_FILE);
  const questions = buildJudgmentQuestions(judgments);

  assert.deepEqual(Object.keys(questions), ["rule_1", "rule_2", "rule_3"]);
  for (const judgment of judgments) {
    assert.equal(questions[judgment.id]?.type, "noul");
    // 规则名和条款原文都要给到模型，否则它不知道要判什么。
    assert.ok(questions[judgment.id]?.instructions.includes(judgment.ruleName));
    assert.ok(questions[judgment.id]?.criteria.true.includes(judgment.criterion));
  }
});

test("新增行扫描返回修改后文件的真实行号", () => {
  const before = "line1\nline2\nline3\n";
  const after = "line1\nchanged\nline3\nadded\n";
  assert.deepEqual(extractChangedLines(before, after).lines.map((line) => line.line), [2, 4]);
});

test("没有修改前内容时整份文件都算新增行", () => {
  const scan = extractChangedLines(undefined, "a\nb\n");
  assert.deepEqual(scan.lines, [{ line: 1, text: "a" }, { line: 2, text: "b" }]);
  assert.equal(scan.truncated, false);
});

test("新增行超过上限时标记 truncated，调用方必须跳过定位", () => {
  const lines = Array.from({ length: MAX_LOCALIZATION_CANDIDATES + 5 }, (_value, index) => `line${index}`).join("\n");
  const scan = extractChangedLines(undefined, `${lines}\n`);

  assert.equal(scan.lines.length, MAX_LOCALIZATION_CANDIDATES);
  assert.equal(scan.truncated, true);
});

test("行定位问题按候选行给出选项，并保留 none 出口", async () => {
  const judgment = await compileOne("## 检查项\n\n1. **禁止 any**：不要用 any。\n");
  const candidates = [{ line: 3, text: "const raw = value;" }, { line: 4, text: "return raw;" }];
  const questions = buildLocalizationQuestions([judgment], candidates);

  const question = questions[`${judgment.id}__line`];
  assert.equal(question?.type, "choice");
  assert.deepEqual(Object.keys(question?.criteria ?? {}), ["3", "4", "none"]);
  assert.match(question?.criteria["3"] ?? "", /第 3 行：const raw = value;/);
  // 指令里必须带条款原文，否则模型不知道在找什么。
  assert.match(question?.instructions ?? "", /不要用 any/);
});

test("行定位在置信度不足或选择 none 时不返回行号", async () => {
  const judgment = await compileOne("## 检查项\n\n1. **禁止 any**：不要用 any。\n");
  const candidates = [{ line: 3, text: "const raw = value;" }];
  const key = `${judgment.id}__line`;

  const lowConfidence = readLocatedLines([judgment], {
    [key]: { type: "choice", choice: "3", confidence: 0.4 },
  }, candidates);
  assert.equal(lowConfidence.size, 0);

  const noLine = readLocatedLines([judgment], {
    [key]: { type: "choice", choice: "none", confidence: 0.99 },
  }, candidates);
  assert.equal(noLine.size, 0);

  const located = readLocatedLines([judgment], {
    [key]: { type: "choice", choice: "3", confidence: 0.8 },
  }, candidates);
  assert.deepEqual(located.get(judgment.id), { line: 3, text: "const raw = value;" });
});

test("命中的条款各产生一条 finding，规则名和行号都独立", async () => {
  const judgments = await compileAll(RULE_FILE);
  const located = new Map([[judgments[0]!.id, { line: 4, text: "const raw = (config as any).timeout;" }]]);

  const findings = buildJudgmentFindings([
    { judgment: judgments[0]!, noul: 0.97, hit: true },
    { judgment: judgments[1]!, noul: 0.2, hit: false },
    { judgment: judgments[2]!, noul: 0.91, hit: true },
  ], located);

  // 违反 2 条就报 2 条，而且能直接看出是哪一条。
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((finding) => finding.ruleGroup), [
    "必须遵守 1 禁止魔法值",
    "必须遵守 3 禁止 any",
  ]);
  assert.equal(findings[0]?.line, 4);
  assert.equal(findings[1]?.line, undefined);
  assert.match(findings[0]?.message ?? "", /命中代码：const raw = \(config as any\).timeout;/);
  assert.match(findings[1]?.message ?? "", /禁止 any/);
});

test("未命中的条款不产生 finding", async () => {
  const judgment = await compileOne("## 检查项\n\n1. **禁止 any**：不要用 any。\n");
  assert.deepEqual(buildJudgmentFindings([{ judgment, noul: 0.1, hit: false }], new Map()), []);
});
