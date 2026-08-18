import assert from "node:assert/strict";
import test from "node:test";
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
    assert.match(result.details.fileEditReview.warnings.join(" "), /未发起审查模型请求/);
  } finally {
    await handlers.get("session_shutdown")?.();
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

    const handlers = new Map<string, TestHandler>();
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

    const handlers = new Map<string, TestHandler>();
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

    const handlers = new Map<string, TestHandler>();
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
