import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  appendSupervisorFallbackAudit,
  buildSupervisorAuditLines,
  renderSupervisorAuditText,
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
  buildCurrentFileContext,
  buildFileEditReviewDiff,
  buildGenericReviewPrompt,
  buildMergedReviewPrompt,
  getLegacyFileEditReviewConfigPath,
  getOverallReviewStatus,
  getPiSupervisorConfigPath,
  loadFileEditReviewConfig,
  loadReviewRule,
  loadReviewRules,
  parseReviewResponse,
  reviewerAppliesToFile,
  reviewerMatchesTool,
  safeSerialize,
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
  assert.equal(loaded.config.maxFileContextChars, 50000);
  assert.equal(loaded.config.maxRuleLines, 100);
  assert.deepEqual(loaded.config.reviewers[0]?.name, "language");
  assert.deepEqual(loaded.warnings, []);
});

test("兼容旧 timeoutMs，并支持秒、返回字符和文件上下文上限配置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-timeout-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    timeoutSeconds: 7,
    maxChars: 3210,
    maxFileContextChars: 43210,
    reviewers: [{ model: "provider/model", rulesFile: "rules.md" }],
  }));
  const loaded = loadFileEditReviewConfig(configFile);
  assert.equal(loaded.config.timeoutSeconds, 7);
  assert.equal(loaded.config.maxOutputChars, 3210);
  assert.equal(loaded.config.maxFileContextChars, 43210);

  await writeFile(configFile, JSON.stringify({
    enabled: true,
    timeoutMs: 2500,
    reviewers: [{ model: "provider/model", rulesFile: "rules.md" }],
  }));
  const legacyLoaded = loadFileEditReviewConfig(configFile);
  assert.equal(legacyLoaded.config.timeoutSeconds, 3);
});

test("reviewer lifecycle 配置保留旧默认并校验通配工具与非法字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-lifecycle-config-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({ enabled: true, reviewers: [
    { model: "provider/model", rulesFile: "rules.md" },
    { model: "provider/model", rulesFile: "rules.md", tools: ["*", "bash"], trigger: "before" },
    { model: "provider/model", rulesFile: "rules.md", tools: ["bash"], trigger: "invalid" },
  ] }));
  const loaded = loadFileEditReviewConfig(configFile);
  assert.deepEqual(loaded.config.reviewers[0]?.tools, ["edit", "write"]);
  assert.equal(loaded.config.reviewers[0]?.trigger, "after");
  assert.deepEqual(loaded.config.reviewers[1]?.tools, ["*"]);
  assert.equal(loaded.config.reviewers[1]?.trigger, "before");
  assert.match(loaded.warnings.join(" "), /忽略其他工具名/);
  assert.match(loaded.warnings.join(" "), /trigger 无效/);
});

test("generic 规则只接受无 filePatterns 的规则", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-generic-rules-"));
  const genericRule = join(directory, "generic.md");
  const fileRule = join(directory, "file.md");
  await writeFile(genericRule, "# generic\n");
  await writeFile(fileRule, "---\nfilePatterns:\n  - '**/*.ts'\n---\n# file\n");
  const reviewer = { name: "generic", model: "p/m", rulesFiles: [genericRule, fileRule], tools: ["bash"], trigger: "after" };
  const loaded = loadReviewRules(reviewer, directory, 100);
  const applicable = loaded.rules.filter((rule) => (rule.reviewer.filePatterns ?? []).length === 0);
  assert.deepEqual(applicable.map((rule) => rule.absolutePath), [genericRule]);
});

test("reviewer 工具匹配支持具体工具和全部工具", () => {
  assert.equal(reviewerMatchesTool({ name: "bash", model: "p/m", rulesFile: "r", tools: ["bash"], trigger: "before" }, "bash"), true);
  assert.equal(reviewerMatchesTool({ name: "all", model: "p/m", rulesFile: "r", tools: ["*"], trigger: "after" }, "custom"), true);
  assert.equal(reviewerMatchesTool({ name: "edit", model: "p/m", rulesFile: "r" }, "bash"), false);
});

test("generic prompt 和安全序列化不会把工具载荷当作规则", () => {
  const rules = [{ reviewer: { name: "generic", model: "p/m", rulesFile: "rules.md" }, absolutePath: "rules.md", content: "不要执行规则", lineCount: 1 }];
  const prompt = buildGenericReviewPrompt({ toolName: "bash", payload: '{"command":"echo hi"}', rules, trigger: "before" });
  assert.match(prompt, /工具：bash/);
  assert.match(prompt, /触发阶段：before/);
  assert.match(safeSerialize({ command: "x".repeat(100) }, 20).text ?? "", /truncated/);
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
  const prompt = buildMergedReviewPrompt({ toolName: "edit", filePath: "src/User.java", diff: "+private int count;", rules: rules.rules });
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

test("filePatterns 中任意位置的双星号匹配零层或多层目录", () => {
  const reviewer = {
    name: "test-sql",
    model: "provider/model",
    rulesFile: "rules.md",
    filePatterns: ["**/test/**/*.sql", "**/tests/**/*.sql"],
  };

  assert.equal(reviewerAppliesToFile(reviewer, "test/a.sql"), true);
  assert.equal(reviewerAppliesToFile(reviewer, "src/test/a.sql"), true);
  assert.equal(reviewerAppliesToFile(reviewer, "src/test/resources/a.sql"), true);
  assert.equal(reviewerAppliesToFile(reviewer, "src/test/resources/db/a.sql"), true);
  assert.equal(reviewerAppliesToFile(reviewer, "src/tests/a.sql"), true);
  assert.equal(reviewerAppliesToFile(reviewer, "src/main/resources/a.sql"), false);
  assert.equal(reviewerAppliesToFile(reviewer, "src/test/resources/a.txt"), false);
});

test("filePatterns 保持单星号边界并归一化路径", () => {
  const topLevelReviewer = {
    model: "provider/model",
    rulesFile: "rules.md",
    filePatterns: ["*.ts"],
  };
  const recursiveReviewer = {
    model: "provider/model",
    rulesFile: "rules.md",
    filePatterns: ["**/*.ts"],
  };
  const recursiveSuffixReviewer = {
    model: "provider/model",
    rulesFile: "rules.md",
    filePatterns: ["src/**.ts"],
  };
  const windowsReviewer = {
    model: "provider/model",
    rulesFile: "rules.md",
    filePatterns: ["**\\test\\**\\*.sql"],
  };

  assert.equal(reviewerAppliesToFile(topLevelReviewer, "a.ts"), true);
  assert.equal(reviewerAppliesToFile(topLevelReviewer, "src/a.ts"), false);
  assert.equal(reviewerAppliesToFile(recursiveReviewer, "a.ts"), true);
  assert.equal(reviewerAppliesToFile(recursiveReviewer, "src/deep/a.ts"), true);
  assert.equal(reviewerAppliesToFile(recursiveSuffixReviewer, "src/deep/a.ts"), true);
  assert.equal(reviewerAppliesToFile(windowsReviewer, ".\\src\\test\\db\\a.sql"), true);
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
  assert.match(diff, /@@ -1,1 \+1,1 @@/);
  assert.match(diff, /-const lang = 'en';/);
  assert.match(diff, /\+const lang = 'zh';/);
  const newFileDiff = buildFileEditReviewDiff("src/new.ts", undefined, "first\nsecond\n");
  assert.match(newFileDiff, /@@ -0,0 \+1,2 @@/);
  assert.match(newFileDiff, /\+second$/);

  const beforeLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const afterLines = [...beforeLines];
  afterLines[1] = "changed 2";
  afterLines[17] = "changed 18";
  const multiHunkDiff = buildFileEditReviewDiff("src/multi.ts", beforeLines.join("\n"), afterLines.join("\n"));
  assert.equal(multiHunkDiff.match(/^@@/gm)?.length, 2);
  assert.doesNotMatch(multiHunkDiff, /^[+-]line 10$/m);

  const parsed = parseReviewResponse(JSON.stringify({
    passed: false,
    summary: "语言不符合规则",
    findings: [{ ruleGroup: "coding-taste", severity: "error", message: "必须使用中文文案", line: 3 }],
  }));
  assert.equal(parsed.passed, false);
  assert.equal(parsed.findings[0]?.line, 3);
  assert.equal(parsed.findings[0]?.ruleGroup, "coding-taste");
});

test("修改后文件上下文携带真实行号，并围绕大文件变更位置有界截取", () => {
  const full = buildCurrentFileContext("first\nsecond\n", "first\nchanged\n", 50000);
  assert.deepEqual(full, { content: "1 | first\n2 | changed", truncated: false });

  const beforeLines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
  const afterLines = [...beforeLines];
  afterLines[249] = "changed line";
  const bounded = buildCurrentFileContext(`${beforeLines.join("\n")}\n`, `${afterLines.join("\n")}\n`, 1000);
  assert.equal(bounded?.truncated, true);
  assert.match(bounded?.content ?? "", /250 \| changed line/);
  assert.ok((bounded?.content.length ?? 0) <= 1000);

  const tiny = buildCurrentFileContext("before\n", `${"x".repeat(100)}\n`, 10);
  assert.equal(tiny?.truncated, true);
  assert.ok((tiny?.content.length ?? 0) <= 10);
});

test("review prompt 同时包含 diff 和带截断标记的修改后文件", () => {
  const rules = [{ reviewer: { name: "file", model: "p/m", rulesFile: "rules.md" }, absolutePath: "rules.md", content: "只审查修改代码", lineCount: 1 }];
  const prompt = buildMergedReviewPrompt({
    toolName: "write",
    filePath: "src/app.ts",
    diff: "+const value = 2;",
    currentFileContext: { content: "8 | const value = 2;", truncated: true },
    rules,
  });
  assert.match(prompt, /<current-file truncated="true">/);
  assert.match(prompt, /8 \| const value = 2;/);
  assert.match(prompt, /只报告 diff 中新增或修改代码的问题/);
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
    ["⛨ Supervisor  ✓ 已通过  edit · 1 个审查器 · 1.4s • Ctrl+O 展开"],
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
    assert.match(output, /⛨ Supervisor  ✓ 已通过  edit · 1 个审查器 · 1\.4s • Ctrl\+O 展开/);
  } finally {
    dispose();
    delete (globalThis as any)[apiKey];
  }
});

test("Supervisor 展开态按 distill 风格展示文件、审查器详情和发现项", () => {
  const audit = buildSupervisorAuditLines("edit", {
    status: "rejected",
    filePath: "src/example.ts",
    durationMs: 2300,
    reviewers: [{
      name: "coding-taste",
      status: "rejected",
      durationMs: 1200,
      rulesFiles: ["rules/style.md"],
      summary: "发现命名不符合项目约定。",
      findings: [{
        ruleGroup: "style",
        line: 3,
        message: "变量名应使用更明确的业务含义。",
      }],
    }],
  }, true);
  assert.ok(audit);
  assert.deepEqual(audit.lines, [
    "⛨ Supervisor  ✕ 未通过  edit · 1 个审查器 · 2.3s",
    "├─ 文件  src/example.ts",
    "└─ 审查器  ✕ 未通过  coding-taste  1.2s",
    "        摘要  发现命名不符合项目约定。",
    "        规则  rules/style.md",
    "        发现  [style] 第 3 行: 变量名应使用更明确的业务含义。",
  ]);

  const styled = renderSupervisorAuditText(audit, {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<b>${text}</b>`,
  });
  assert.match(styled, /<accent><b>⛨ Supervisor<\/b><\/accent>/);
  assert.match(styled, /<error>✕ 未通过<\/error>/);
  assert.match(styled, /<success>摘要<\/success>/);
  assert.match(styled, /<error>发现<\/error>/);
});

test("失败工具结果保留原错误并跳过 after reviewer", () => {
  const audit = { status: "skipped", toolName: "bash", reviewers: [{ name: "bash", model: "p/m", status: "skipped", durationMs: 0, error: "工具调用失败，跳过 after 审查。" }], durationMs: 1, warnings: [] };
  assert.equal(audit.status, "skipped");
  assert.equal(audit.reviewers[0]?.status, "skipped");
  assert.match(audit.reviewers[0]?.error ?? "", /跳过/);
});

test("pi-tool-supervisor 通过 Pi 工具事件独立接入，不注册或依赖工具覆盖", async () => {
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-file-review-extension-"));
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    let registeredToolCount = 0;
    const registeredCommandNames: string[] = [];
    const pi = {
      // The shared display host is initialized by the supervisor now. Mark all
      // built-ins as externally owned so this test isolates supervisor wiring
      // instead of counting the host's tool registrations.
      getAllTools: () => ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({
        name,
        sourceInfo: { source: "pi-tool-supervisor-test" },
      })),
      registerTool: () => { registeredToolCount += 1; },
      registerCommand: (name: string) => { registeredCommandNames.push(name); },
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
    assert.ok(registeredCommandNames.includes("config:tool-supervisor"));
    assert.ok(registeredCommandNames.includes("pi-tool-supervisor"));
    assert.equal(result.content[0].text, "Wrote file");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("上级请求已终止时不发起审查模型请求", async () => {
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-aborted-"));
  const projectDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-aborted-project-"));
  const controller = new AbortController();
  const handlers = new Map<string, (...args: any[]) => any>();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const rulesFile = join(projectDir, "java-rules.md");
    await writeFile(rulesFile, `---
name: java-local
filePatterns:
  - "**/*.java"
---

# Java

1. 只审查修改内容。
`);
    await mkdir(join(agentDir, "extensions", "pi-tool-supervisor"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-tool-supervisor", "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [{ name: "java-local", model: "provider/model", rulesFile }],
    }));

    let findCalls = 0;
    let authCalls = 0;
    const pi = {
      getAllTools: () => ["edit", "write"].map((name) => ({ name, sourceInfo: { source: "test" } })),
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    } as any;
    piSupervisorExtension(pi);

    const context = {
      cwd: projectDir,
      signal: controller.signal,
      modelRegistry: {
        find: () => {
          findCalls += 1;
          return {};
        },
        getApiKeyAndHeaders: async () => {
          authCalls += 1;
          return { ok: true, apiKey: "test-key", headers: {}, env: {} };
        },
      },
    };
    const input = { path: "src/Example.java", content: "class Example {}\n" };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: "write",
      toolCallId: "write-aborted-1",
      input,
    }, context);
    controller.abort();
    const result = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "write",
      toolCallId: "write-aborted-1",
      input,
      content: [{ type: "text", text: "Wrote file" }],
      details: {},
      isError: false,
    }, context);

    assert.equal(findCalls, 0);
    assert.equal(authCalls, 0);
    assert.equal(result.details.fileEditReview.status, "skipped");
    assert.deepEqual(result.details.fileEditReview.reviewers, []);
    assert.match(result.details.fileEditReview.warnings.join(" "), /取消|未发起/);
  } finally {
    await handlers.get("session_shutdown")?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("用户中断会一起终止所有尚未完成的审查请求", async () => {
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  type ExtensionTestHandler = (...args: unknown[]) => unknown;
  type ExtensionToolResult = {
    details: {
      fileEditReview: {
        status: string;
        reviewers: Array<{ status: string; error?: string }>;
        warnings: string[];
      };
    };
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-inflight-abort-"));
  const projectDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-inflight-abort-project-"));
  const faux = registerFauxProvider({
    provider: "supervisor-abort",
    models: [{ id: "model" }],
  });
  const handlers = new Map<string, ExtensionTestHandler>();
  const providerSignals: AbortSignal[] = [];
  const releaseResponses: Array<() => void> = [];
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const firstRule = join(projectDir, "first-rules.md");
    const secondRule = join(projectDir, "second-rules.md");
    const ruleContents = `---
filePatterns:
  - "**/*.java"
---

# Java

1. 只审查修改内容。
`;
    await writeFile(firstRule, ruleContents);
    await writeFile(secondRule, ruleContents);
    await mkdir(join(agentDir, "extensions", "pi-tool-supervisor"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "pi-tool-supervisor", "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [
        { name: "first", model: "supervisor-abort/model", rulesFile: firstRule },
        { name: "second", model: "supervisor-abort/model", rulesFile: secondRule },
      ],
    }));
    faux.setResponses(Array.from({ length: 2 }, () => (_context, options) => new Promise((resolve) => {
      const providerSignal = options?.signal;
      if (providerSignal) providerSignals.push(providerSignal);
      /** Settles one faux review response when its request finishes or is cancelled. */
      const finish = () => resolve(providerSignal?.aborted
        ? fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "fake review aborted" })
        : fauxAssistantMessage(JSON.stringify({ passed: true, summary: "ok", findings: [] })));
      releaseResponses.push(finish);
      providerSignal?.addEventListener("abort", finish, { once: true });
      if (releaseResponses.length === 2) markStarted?.();
    })));

    const pi = {
      getAllTools: () => ["edit", "write"].map((name) => ({ name, sourceInfo: { source: "test" } })),
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: ExtensionTestHandler) => handlers.set(event, handler),
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);

    const controller = new AbortController();
    const context = {
      cwd: projectDir,
      signal: controller.signal,
      modelRegistry: {
        find: () => faux.getModel(),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, env: {} }),
      },
    };
    const input = { path: "src/Example.java", content: "class Example {}\n" };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: "write",
      toolCallId: "write-inflight-abort-1",
      input,
    }, context);
    const resultPromise = handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "write",
      toolCallId: "write-inflight-abort-1",
      input,
      content: [{ type: "text", text: "Wrote file" }],
      details: {},
      isError: false,
    }, context);

    await started;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const allProviderRequestsAborted = providerSignals.length === 2
      && providerSignals.every((signal) => signal.aborted);
    for (const release of releaseResponses) release();
    const result = await resultPromise as ExtensionToolResult;

    assert.equal(allProviderRequestsAborted, true);
    assert.equal(result.details.fileEditReview.status, "skipped");
    assert.equal(result.details.fileEditReview.reviewers.length, 2);
    assert.ok(result.details.fileEditReview.reviewers.every((reviewer) => reviewer.status === "skipped"));
    assert.ok(result.details.fileEditReview.reviewers.every((reviewer) => /终止|取消/.test(reviewer.error ?? "")));
    assert.match(result.details.fileEditReview.warnings.join(" "), /终止|取消/);
  } finally {
    for (const release of releaseResponses) release();
    await handlers.get("session_shutdown")?.();
    faux.unregister();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("generic before 即使输入含 path 也只使用无文件模式规则", async () => {
  type ReviewResult = { details: { fileEditReview: { reviewers: Array<{ name: string; error?: string }>; filePath?: string } } };
  type TestHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-generic-before-path-"));
  const handlers = new Map<string, TestHandler>();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const rulesDirectory = join(agentDir, "rules");
    await mkdir(rulesDirectory, { recursive: true });
    const genericRule = join(rulesDirectory, "generic.md");
    const fileRule = join(rulesDirectory, "file.md");
    await writeFile(genericRule, "# generic\\n");
    await writeFile(fileRule, "---\\nfilePatterns:\\n  - '**/*.ts'\\n---\\n# file\\n");
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [{ name: "read-before", model: "provider/model", rulesFiles: [genericRule, fileRule], tools: ["read"], trigger: "before" }],
    }));

    const pi = {
      getAllTools: () => [],
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: TestHandler) => handlers.set(event, handler),
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);
    const context = {
      cwd: agentDir,
      modelRegistry: { find: () => undefined },
    };
    const input = { path: "src/example.ts", query: "content" };
    await handlers.get("tool_call")?.({ toolName: "read", toolCallId: "read-path-1", input }, context);
    const result = await handlers.get("tool_result")?.({
      toolName: "read",
      toolCallId: "read-path-1",
      input,
      content: [{ type: "text", text: "content" }],
      details: {},
      isError: false,
    }, context) as ReviewResult;

    assert.equal(result.details.fileEditReview.reviewers.length, 1);
    assert.equal(result.details.fileEditReview.reviewers[0].name, "read-before");
    assert.match(result.details.fileEditReview.reviewers[0].error, /模型不存在/);
    assert.equal(result.details.fileEditReview.filePath, undefined);
  } finally {
    await handlers.get("session_shutdown")?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("自定义工具支持精确名和通配符 after 审查并展示审计", async () => {
  type ReviewResult = { details: { fileEditReview: { reviewers: Array<{ name: string }>; status: string }; source: string } };
  type TestHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-custom-after-"));
  const handlers = new Map<string, TestHandler>();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const rulesFile = join(agentDir, "generic.md");
    await writeFile(rulesFile, "# generic\\n");
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [
        { name: "exact", model: "provider/model", rulesFile, tools: ["custom-tool"], trigger: "after" },
        { name: "wildcard", model: "provider/model", rulesFile, tools: ["*"], trigger: "after" },
      ],
    }));

    const pi = {
      getAllTools: () => [],
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: TestHandler) => handlers.set(event, handler),
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);
    const context = { cwd: agentDir, modelRegistry: { find: () => undefined } };
    const input = { path: "not-a-file-review-path", value: 1 };
    await handlers.get("tool_call")?.({ toolName: "custom-tool", toolCallId: "custom-1", input }, context);
    const result = await handlers.get("tool_result")?.({
      toolName: "custom-tool",
      toolCallId: "custom-1",
      input,
      content: [{ type: "text", text: "ok" }],
      details: { source: "custom" },
      isError: false,
    }, context) as ReviewResult;

    assert.deepEqual(result.details.fileEditReview.reviewers.map((reviewer) => reviewer.name), ["exact", "wildcard"]);
    assert.equal(result.details.fileEditReview.status, "failed");
    assert.equal(result.details.source, "custom");
  } finally {
    await handlers.get("session_shutdown")?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("generic 载荷序列化失败形成可见 failed 审计并保持原结果", async () => {
  type ReviewResult = { content: Array<{ text?: string }>; details: { original: boolean; fileEditReview: { status: string; reviewers: Array<{ error?: string }> } } };
  type TestHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-serialization-failure-"));
  const handlers = new Map<string, TestHandler>();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const rulesFile = join(agentDir, "generic.md");
    await writeFile(rulesFile, "# generic\\n");
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [{ name: "before", model: "provider/model", rulesFile, tools: ["custom-tool"], trigger: "before" }],
    }));

    const pi = {
      getAllTools: () => [],
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: TestHandler) => handlers.set(event, handler),
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);
    const context = { cwd: agentDir, modelRegistry: { find: () => { throw new Error("不应调用模型"); } } };
    const input = { toJSON: () => { throw new Error("循环代理失败"); } };
    await handlers.get("tool_call")?.({ toolName: "custom-tool", toolCallId: "custom-serialization-1", input }, context);
    const result = await handlers.get("tool_result")?.({
      toolName: "custom-tool",
      toolCallId: "custom-serialization-1",
      input,
      content: [{ type: "text", text: "original" }],
      details: { original: true },
      isError: false,
    }, context) as ReviewResult;

    assert.equal(result.content[0]?.text, "original");
    assert.equal(result.details.original, true);
    assert.equal(result.details.fileEditReview.status, "failed");
    assert.match(result.details.fileEditReview.reviewers[0].error, /序列化失败/);
  } finally {
    await handlers.get("session_shutdown")?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("generic before rejected 阻断时诊断使用工具名并追加独立审计", async () => {
  type TestHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  type BlockResult = { block?: boolean; reason?: string };
  type AuditEntryData = { toolName: string; audit: { toolName: string } };
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-before-rejected-"));
  const handlers = new Map<string, TestHandler>();
  const entries: Array<{ type: string; data: AuditEntryData }> = [];
  const faux = registerFauxProvider({ provider: "provider", models: [{ id: "model" }] });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const rulesFile = join(agentDir, "generic.md");
    await writeFile(rulesFile, "# generic\\n");
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [{ name: "before", model: "provider/model", rulesFile, tools: ["custom-tool"], trigger: "before" }],
    }));
    faux.setResponses([fauxAssistantMessage(JSON.stringify({
      passed: false,
      summary: "输入不符合规则",
      findings: [{ message: "禁止调用该工具" }],
    }))]);

    const pi = {
      getAllTools: () => [],
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: (type: string, data: unknown) => entries.push({ type, data: data as AuditEntryData }),
      on: (event: string, handler: TestHandler) => handlers.set(event, handler),
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);
    const context = {
      cwd: agentDir,
      modelRegistry: {
        find: () => faux.getModel(),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, env: {} }),
      },
    };
    const block = await handlers.get("tool_call")?.({ toolName: "custom-tool", toolCallId: "blocked-1", input: { value: 1 } }, context) as BlockResult;

    assert.equal(block.block, true);
    assert.match(block.reason ?? "", /工具：custom-tool/);
    assert.doesNotMatch(block.reason, /undefined/);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.data.toolName, "custom-tool");
    assert.equal(entries[0]?.data.audit.toolName, "custom-tool");
    assert.equal(await handlers.get("tool_result")?.({ toolCallId: "blocked-1" }, context), undefined);
  } finally {
    faux.unregister();
    await handlers.get("session_shutdown")?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("before failed 和 skipped 放行时在 tool_result 中保留可见审计", async () => {
  type TestHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-before-status-"));
  const handlers = new Map<string, TestHandler>();
  const faux = registerFauxProvider({ provider: "provider", models: [{ id: "model" }] });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const failedRules = join(agentDir, "failed.md");
    const skippedRules = join(agentDir, "skipped.md");
    await writeFile(failedRules, "# failed\n");
    await writeFile(skippedRules, "---\nfilePatterns:\n  - '**/*.ts'\n---\n# skipped\n");
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [
        { name: "failed", model: "provider/model", rulesFile: failedRules, tools: ["custom-tool"], trigger: "before" },
        { name: "skipped", model: "provider/model", rulesFile: skippedRules, tools: ["custom-tool"], trigger: "before" },
      ],
    }));
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ passed: true, summary: "ok", findings: [] }))]);

    const pi = {
      getAllTools: () => [],
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: TestHandler) => handlers.set(event, handler),
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);
    const context = {
      cwd: agentDir,
      modelRegistry: { find: () => undefined },
    };
    await handlers.get("tool_call")?.({ toolName: "custom-tool", toolCallId: "status-1", input: { value: 1 } }, context);
    const result = await handlers.get("tool_result")?.({
      toolName: "custom-tool",
      toolCallId: "status-1",
      input: { value: 1 },
      content: [{ type: "text", text: "original" }],
      details: { original: true },
      isError: false,
    }, context);

    const reviewResult = result as { details: { fileEditReview: { status: string; reviewers: Array<{ status: string }> } }; content: Array<{ text?: string }> };
    assert.equal(reviewResult.details.fileEditReview.status, "failed");
    assert.deepEqual(reviewResult.details.fileEditReview.reviewers.map((reviewer) => reviewer.status), ["failed", "skipped"]);
    assert.match(reviewResult.content.at(-1)?.text ?? "", /文件：custom-tool/);
    assert.doesNotMatch(reviewResult.content.at(-1)?.text ?? "", /文件：undefined/);
  } finally {
    faux.unregister();
    await handlers.get("session_shutdown")?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("edit/write after 使用实际快照 diff，并在无变化时跳过模型", async () => {
  type TestHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-file-lifecycle-"));
  const handlers = new Map<string, TestHandler>();
  const prompts: string[] = [];
  const faux = registerFauxProvider({ provider: "provider", models: [{ id: "model" }] });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const target = join(agentDir, "example.ts");
    const rulesFile = join(agentDir, "file.md");
    await writeFile(target, "const value = 1;\n");
    await writeFile(rulesFile, "---\nfilePatterns:\n  - '**/*.ts'\n---\n# file\n");
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [{ name: "file", model: "provider/model", rulesFile, tools: ["write"], trigger: "after" }],
    }));
    faux.setResponses([(reviewContext) => {
      prompts.push(JSON.stringify(reviewContext.messages));
      return fauxAssistantMessage(JSON.stringify({ passed: true, summary: "ok", findings: [] }));
    }]);

    const pi = {
      getAllTools: () => [],
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: TestHandler) => handlers.set(event, handler),
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);
    const context = {
      cwd: agentDir,
      modelRegistry: {
        find: () => faux.getModel(),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, env: {} }),
      },
    };
    await handlers.get("tool_call")?.({ toolName: "write", toolCallId: "write-diff", input: { path: "example.ts", content: "const value = 2;\n" } }, context);
    await writeFile(target, "const value = 2;\n");
    const changed = await handlers.get("tool_result")?.({ toolName: "write", toolCallId: "write-diff", input: { path: "example.ts", content: "const value = 2;\n" }, content: [{ type: "text", text: "written" }], details: {}, isError: false }, context) as { details: { fileEditReview: { status: string } } };
    assert.equal(changed.details.fileEditReview.status, "passed");
    assert.match(prompts[0], /-const value = 1;/);
    assert.match(prompts[0], /\+const value = 2;/);
    assert.match(prompts[0], /<current-file truncated=\\"false\\">/);
    assert.match(prompts[0], /1 \| const value = 2;/);

    await handlers.get("tool_call")?.({ toolName: "write", toolCallId: "write-same", input: { path: "example.ts", content: "const value = 2;\n" } }, context);
    const unchanged = await handlers.get("tool_result")?.({ toolName: "write", toolCallId: "write-same", input: { path: "example.ts", content: "const value = 2;\n" }, content: [{ type: "text", text: "unchanged" }], details: {}, isError: false }, context) as { details: { fileEditReview: { status: string } } };
    assert.equal(unchanged.details.fileEditReview.status, "skipped");
    assert.equal(faux.state.callCount, 1);
  } finally {
    faux.unregister();
    await handlers.get("session_shutdown")?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("custom exact 和 wildcard after 成功审查 input/result，并保留工具失败原结果", async () => {
  type TestHandler = (...args: unknown[]) => Promise<unknown> | unknown;
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-generic-success-"));
  const handlers = new Map<string, TestHandler>();
  const prompts: string[] = [];
  const faux = registerFauxProvider({ provider: "provider", models: [{ id: "model" }] });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const rulesFile = join(agentDir, "generic.md");
    await writeFile(rulesFile, "# generic\\n");
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.json"), JSON.stringify({
      enabled: true,
      reviewers: [
        { name: "exact", model: "provider/model", rulesFile, tools: ["custom-tool"], trigger: "after" },
        { name: "wildcard", model: "provider/model", rulesFile, tools: ["*"], trigger: "after" },
      ],
    }));
    faux.setResponses([
      (reviewContext) => { prompts.push(JSON.stringify(reviewContext.messages)); return fauxAssistantMessage(JSON.stringify({ passed: true, summary: "exact ok", findings: [] })); },
      (reviewContext) => { prompts.push(JSON.stringify(reviewContext.messages)); return fauxAssistantMessage(JSON.stringify({ passed: true, summary: "wildcard ok", findings: [] })); },
    ]);

    const pi = {
      getAllTools: () => [],
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      on: (event: string, handler: TestHandler) => handlers.set(event, handler),
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);
    const context = {
      cwd: agentDir,
      modelRegistry: {
        find: () => faux.getModel(),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test", headers: {}, env: {} }),
      },
    };
    const input = { value: 1 };
    await handlers.get("tool_call")?.({ toolName: "custom-tool", toolCallId: "custom-success", input }, context);
    const result = await handlers.get("tool_result")?.({ toolName: "custom-tool", toolCallId: "custom-success", input, content: [{ type: "text", text: "ok" }], details: { source: "custom" }, isError: false }, context) as { details: { source: string; fileEditReview: { status: string; reviewers: Array<{ name: string }> } } };
    const reviewResult = result as { details: { source: string; fileEditReview: { status: string; reviewers: Array<{ name: string }> } } };
    assert.equal(reviewResult.details.source, "custom");
    assert.equal(reviewResult.details.fileEditReview.status, "passed");
    assert.deepEqual(reviewResult.details.fileEditReview.reviewers.map((reviewer) => reviewer.name), ["exact", "wildcard"]);
    assert.match(prompts[0], /custom-tool/);
    assert.match(prompts[0], /input/);
    assert.match(prompts[0], /result/);

    await handlers.get("tool_call")?.({ toolName: "custom-tool", toolCallId: "custom-failed", input }, context);
    const failed = await handlers.get("tool_result")?.({ toolName: "custom-tool", toolCallId: "custom-failed", input, content: [{ type: "text", text: "original error" }], details: { source: "custom" }, isError: true }, context) as { content: Array<{ text?: string }>; details: { fileEditReview: { reviewers: Array<{ status: string }> } } };
    assert.equal(failed.content[0]?.text, "original error");
    assert.deepEqual(failed.details.fileEditReview.reviewers.map((reviewer) => reviewer.status), ["skipped", "skipped"]);
  } finally {
    faux.unregister();
    await handlers.get("session_shutdown")?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

type ConfigCommand = { handler: (args: string, ctx: unknown) => Promise<void> };

test("配置 UI 可以编辑并持久化 reviewer 的 tools 和 trigger", async () => {
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-config-ui-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "config.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      reviewers: [{ name: "reviewer", model: "provider/model", rulesFile: "rules.md" }],
    }));
    const commands = new Map<string, ConfigCommand>();
    let configSelections = 0;
    let editSelections = 0;
    const pi = {
      getAllTools: () => [],
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      registerCommand: (name: string, command: ConfigCommand) => commands.set(name, command),
      on: () => undefined,
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);
    const ctx = {
      hasUI: true,
      ui: {
        select: async (_title: string, choices: string[]) => {
          if (choices.some((choice) => choice.startsWith("● "))) {
            return configSelections++ === 0 ? choices.find((choice) => choice.startsWith("● ")) : undefined;
          }
          if (editSelections === 0) {
            editSelections += 1;
            return choices.find((choice) => choice.startsWith("工具范围："));
          }
          if (editSelections === 1) {
            editSelections += 1;
            return choices.find((choice) => choice.startsWith("触发阶段："));
          }
          if (choices.includes("before") && choices.includes("after")) return "before";
          return "返回";
        },
        input: async (title: string, current: string) => title.startsWith("工具范围") ? "bash, *" : current,
        confirm: async () => false,
        notify: () => undefined,
      },
    };
    await commands.get("config:tool-supervisor")?.handler("", ctx);
    const saved = JSON.parse(await (await import("node:fs/promises")).readFile(configPath, "utf8"));
    assert.deepEqual(saved.reviewers[0].tools, ["*"]);
    assert.equal(saved.reviewers[0].trigger, "before");
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
