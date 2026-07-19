import assert from "node:assert/strict";
import test from "node:test";
import {
  appendSupervisorFallbackAudit,
  buildSupervisorAuditLines,
  SUPERVISOR_AUDIT_ENTRY_TYPE,
} from "../src/fallback-renderer.ts";
import {
  isSupervisorToolDisplayMiddlewareActive,
  registerSupervisorToolDisplayMiddleware,
} from "../src/tool-display-bridge.ts";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFileEditReviewDiff,
  buildMergedReviewPrompt,
  getLegacyFileEditReviewConfigPath,
  getOverallReviewStatus,
  getPiSupervisorConfigPath,
  loadFileEditReviewConfig,
  loadReviewRule,
  loadReviewRules,
  parseReviewResponse,
  reviewerAppliesToFile,
} from "../src/review-utils.ts";

process.env.PI_EXTENSIONS_LOCALE = "zh-CN";

test("只加载有效的侧边审查配置，并提供默认参数", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    reviewers: [{ name: "language", model: "provider/model", rulesFile: "rules.md", filePatterns: ["**/*.java"] }],
  }));

  const loaded = loadFileEditReviewConfig(configFile);
  assert.equal(loaded.config.enabled, true);
  assert.equal(loaded.config.timeoutSeconds, 10);
  assert.equal(loaded.config.maxOutputChars, 10000);
  assert.equal(loaded.config.maxRuleLines, 100);
  assert.deepEqual(loaded.config.reviewers[0]?.name, "language");
  assert.deepEqual(loaded.warnings, []);
});

test("兼容旧 timeoutMs，并支持秒和返回字符上限配置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-timeout-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    timeoutSeconds: 7,
    maxChars: 3210,
    reviewers: [{ model: "provider/model", rulesFile: "rules.md" }],
  }));
  const loaded = loadFileEditReviewConfig(configFile);
  assert.equal(loaded.config.timeoutSeconds, 7);
  assert.equal(loaded.config.maxOutputChars, 3210);

  await writeFile(configFile, JSON.stringify({
    enabled: true,
    timeoutMs: 2500,
    reviewers: [{ model: "provider/model", rulesFile: "rules.md" }],
  }));
  const legacyLoaded = loadFileEditReviewConfig(configFile);
  assert.equal(legacyLoaded.config.timeoutSeconds, 3);
});

test("reviewer 可以单独禁用，全部禁用时不启用审查器", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-disabled-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    reviewers: [{ name: "disabled", enabled: false, model: "provider/model", rulesFile: "rules.md", filePatterns: ["**/*.java"] }],
  }));

  const loaded = loadFileEditReviewConfig(configFile);
  assert.equal(loaded.config.enabled, false);
  assert.equal(loaded.config.reviewers[0]?.enabled, false);
});

test("一个 reviewer 可以加载多个规则文件，并拒绝混用旧新配置字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-multi-rules-"));
  const firstRule = join(directory, "first.md");
  const secondRule = join(directory, "second.md");
  await writeFile(firstRule, `---
name: first-rule
complexity: local
consumers:
  - editor-review
filePatterns:
  - "**/*.java"
---

# 第一组规则

1. 第一条规则。
`);
  await writeFile(secondRule, `---
name: second-rule
complexity: local
consumers:
  - editor-review
filePatterns:
  - "**/*.java"
---

# 第二组规则

1. 第二条规则。
`);
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    reviewers: [{ name: "java-local", model: "provider/model", rulesFiles: [firstRule, secondRule] }],
  }));

  const loaded = loadFileEditReviewConfig(configFile);
  assert.equal(loaded.config.reviewers[0]?.rulesFile, undefined);
  assert.deepEqual(loaded.config.reviewers[0]?.rulesFiles, [firstRule, secondRule]);
  const rules = loadReviewRules(loaded.config.reviewers[0]!, directory, 100);
  assert.equal(rules.errors.length, 0);
  assert.deepEqual(rules.rules.map((rule) => rule.reviewer.name), ["first-rule", "second-rule"]);
  const prompt = buildMergedReviewPrompt("edit", "src/User.java", "+private int count;", rules.rules);
  assert.match(prompt, /<rules name="first-rule">/);
  assert.match(prompt, /<rules name="second-rule">/);

  await writeFile(configFile, JSON.stringify({
    enabled: true,
    reviewers: [{ name: "invalid", model: "provider/model", rulesFile: firstRule, rulesFiles: [secondRule] }],
  }));
  const invalid = loadFileEditReviewConfig(configFile);
  assert.equal(invalid.config.reviewers.length, 0);
  assert.match(invalid.warnings[0] ?? "", /无效/);
});

test("规则文件 front matter 控制启用状态和文件匹配范围", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-frontmatter-"));
  const ruleFile = join(directory, "rules.md");
  await writeFile(ruleFile, `---
name: java-only
enabled: false
complexity: local
consumers:
  - editor-review
  - code-review
filePatterns:
  - "**/*.java"
---

# 规则

1. 只审查修改行。
`);
  const rule = loadReviewRule(
    { name: "fallback", model: "provider/model", rulesFile: ruleFile },
    directory,
    100,
  );
  assert.equal(rule.reviewer.name, "java-only");
  assert.equal(rule.reviewer.enabled, false);
  assert.equal(rule.reviewer.complexity, "local");
  assert.deepEqual(rule.reviewer.consumers, ["editor-review", "code-review"]);
  assert.deepEqual(rule.reviewer.filePatterns, ["**/*.java"]);
  assert.doesNotMatch(rule.content, /filePatterns/);
});

test("reviewer 文件匹配条件只作用于 Java 文件", () => {
  const reviewer = {
    name: "java",
    model: "provider/model",
    rulesFile: "rules.md",
    enabled: true,
    filePatterns: ["**/*.java"],
  };
  assert.equal(reviewerAppliesToFile(reviewer, "src/main/Order.java"), true);
  assert.equal(reviewerAppliesToFile(reviewer, "src/main/Order.ts"), false);
});

test("规则文件超过 100 行时返回警告", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-rule-"));
  const ruleFile = join(directory, "rules.md");
  await writeFile(ruleFile, `${Array.from({ length: 101 }, (_, index) => `规则 ${index + 1}`).join("\n")}\n`);
  const rule = loadReviewRule(
    { name: "long", model: "provider/model", rulesFile: ruleFile, enabled: true, filePatterns: [] },
    directory,
    100,
  );
  assert.equal(rule.lineCount, 102);
  assert.match(rule.warning ?? "", /超过 100 行/);
});

test("生成实际文件 diff 并解析结构化审查结果", () => {
  const diff = buildFileEditReviewDiff("src/app.ts", "const lang = 'en';\n", "const lang = 'zh';\n");
  assert.match(diff, /--- a\/src\/app\.ts/);
  assert.match(diff, /-const lang = 'en';/);
  assert.match(diff, /\+const lang = 'zh';/);

  const parsed = parseReviewResponse(JSON.stringify({
    passed: false,
    summary: "语言不符合规则",
    findings: [{ ruleGroup: "coding-taste", severity: "error", message: "必须使用中文文案", line: 3 }],
  }));
  assert.equal(parsed.passed, false);
  assert.equal(parsed.findings[0]?.line, 3);
  assert.equal(parsed.findings[0]?.ruleGroup, "coding-taste");
});

test("审查结果状态优先级为 rejected、failed、passed", () => {
  assert.equal(getOverallReviewStatus([]), "skipped");
  assert.equal(getOverallReviewStatus([{
    name: "a", model: "p/m", rulesFile: "a.md", status: "passed", durationMs: 1,
  }]), "passed");
  assert.equal(getOverallReviewStatus([
    { name: "a", model: "p/m", rulesFile: "a.md", status: "failed", durationMs: 1 },
    { name: "b", model: "p/m", rulesFile: "b.md", status: "passed", durationMs: 1 },
  ]), "failed");
  assert.equal(getOverallReviewStatus([
    { name: "a", model: "p/m", rulesFile: "a.md", status: "rejected", durationMs: 1 },
    { name: "b", model: "p/m", rulesFile: "b.md", status: "failed", durationMs: 1 },
  ]), "rejected");
});

test("pi-tool-supervisor 可以追加 UI-only 保底审计", () => {
  const entries: Array<{ type: string; data: unknown }> = [];
  const builtinPi = {
    getAllTools: () => [{ name: "edit", sourceInfo: { path: "<builtin:edit>" } }],
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  } as any;
  const details = {
    fileEditReview: {
      status: "passed",
      filePath: "src/example.ts",
      durationMs: 1400,
      warnings: [],
      reviewers: [{ name: "coding-taste", status: "passed", durationMs: 1200 }],
    },
  };

  assert.equal(appendSupervisorFallbackAudit(builtinPi, "edit", details), true);
  assert.equal(entries[0]?.type, SUPERVISOR_AUDIT_ENTRY_TYPE);
  assert.deepEqual(
    buildSupervisorAuditLines("edit", details.fileEditReview, false)?.lines,
    ["✦ supervisor · edit · 已通过 · 1 个审查器 · 1.4s"],
  );

  assert.equal(entries.length, 1);
});

test("pi-tool-supervisor 通过通用 tool-display result middleware 追加审查卡片", () => {
  const apiKey = Symbol.for("pi-tool-display.api.v1");
  let registration: any;
  (globalThis as any)[apiKey] = {
    registerResultRenderMiddleware(value: any) {
      registration = value;
      return value.id;
    },
    unregisterResultRenderMiddleware: () => true,
    hasResultRenderMiddleware: (id: string) => id === "pi-tool-supervisor.result-renderer.v1",
    isResultRenderPipelineActive: (toolName: string) => toolName === "edit",
  };
  const dispose = registerSupervisorToolDisplayMiddleware();
  try {
    assert.equal(isSupervisorToolDisplayMiddlewareActive("edit"), true);
    assert.equal(isSupervisorToolDisplayMiddlewareActive("write"), false);
    const component = registration.middleware({
      toolName: "edit",
      result: {
        details: {
          fileEditReview: {
            status: "passed",
            durationMs: 1400,
            reviewers: [{ name: "coding-taste", status: "passed", durationMs: 1200 }],
          },
        },
      },
      options: { expanded: false },
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    }, () => new Text("基础 diff", 0, 0));
    const output = component.render(120).join("\n");
    assert.match(output, /基础 diff/);
    assert.match(output, /✦ supervisor · edit · 已通过 · 1 个审查器 · 1\.4s/);
  } finally {
    dispose();
    delete (globalThis as any)[apiKey];
  }
});

test("pi-tool-supervisor 通过 Pi 工具事件独立接入，不注册或依赖工具覆盖", async () => {
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-file-review-extension-"));
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    let registeredToolCount = 0;
    let registeredCommandName: string | undefined;
    const pi = {
      getAllTools: () => [{ name: "write", sourceInfo: { path: "<builtin:write>" } }],
      registerTool: () => { registeredToolCount += 1; },
      registerCommand: (name: string) => { registeredCommandName = name; },
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    } as any;
    piSupervisorExtension(pi);

    const input = { path: "src/example.ts", content: "const ok = true;\n" };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: "write",
      toolCallId: "write-1",
      input,
    }, { cwd: process.cwd() });
    const result = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "write",
      toolCallId: "write-1",
      input,
      content: [{ type: "text", text: "Wrote file" }],
      details: {},
      isError: false,
    }, { cwd: process.cwd() });

    assert.equal(registeredToolCount, 0);
    assert.equal(registeredCommandName, "pi-tool-supervisor");
    assert.equal(result.content[0].text, "Wrote file");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("新配置不存在时读取 pi-file-edit-review 旧配置", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-legacy-config-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const newConfigPath = getPiSupervisorConfigPath();
    const legacyConfigPath = getLegacyFileEditReviewConfigPath();
    await mkdir(join(agentDir, "extensions", "pi-file-edit-review"), { recursive: true });
    await writeFile(legacyConfigPath, JSON.stringify({
      enabled: true,
      reviewers: [{ name: "legacy", model: "provider/model", rulesFile: "rules.md" }],
    }));

    const loaded = loadFileEditReviewConfig();

    assert.equal(loaded.configPath, legacyConfigPath);
    assert.notEqual(loaded.configPath, newConfigPath);
    assert.equal(loaded.config.reviewers[0]?.name, "legacy");
    assert.match(loaded.warnings[0] ?? "", /\/pi-tool-supervisor/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
