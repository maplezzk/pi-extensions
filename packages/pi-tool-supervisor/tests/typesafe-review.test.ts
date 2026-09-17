import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileEditReviewConfig } from "../src/review-utils.ts";

process.env.PI_EXTENSIONS_LOCALE = "zh-CN";

const SWALLOWED_ERROR_RULE = `---
name: no-swallowed-error
severity: error
threshold: 0.85
---
# 不得静默吞掉异常

## 判据
true: 新增行捕获错误后静默继续，例如空 catch 或用默认值掩盖失败
false: 通过抛出或记录日志报告失败

## 修复提示
把失败显式抛给调用方，不要用默认值掩盖。
`;

const PROSE_ONLY_RULE = `# 只有散文规则

1. 不要吞异常。
`;

/** 一个文件里两条规则：一条阻断、一条只提示。 */
const MULTI_BLOCK_RULE = `---
name: js-quality
---
# JS/TS 代码质量

## 规则：no-swallowed-error
severity: error
threshold: 0.85

## 判据
true: 新增行捕获错误后静默继续，例如空 catch 或用默认值掩盖失败
false: 通过抛出或记录日志报告失败

## 修复提示
把失败显式抛给调用方，不要用默认值掩盖。

## 规则：no-magic-number
severity: warning
threshold: 0.85

## 判据
true: 新增行直接写了魔法数字
false: 已经提取成具名常量

## 修复提示
把魔法数字提取成具名常量。
`;

/** 测试用的最小 Pi 扩展宿主；只覆盖 supervisor 实际调用的方法。 */
type Handler = (...args: unknown[]) => unknown;

function createPi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const tools = ["read", "grep", "find", "ls", "bash", "edit", "write"].map((name) => ({
    name,
    sourceInfo: { source: "pi-tool-supervisor-test" },
  }));
  const pi = {
    getAllTools: () => tools,
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerEntryRenderer: () => undefined,
    appendEntry: () => undefined,
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers };
}

type AuditReviewer = {
  name?: string;
  model?: string;
  status?: string;
  summary?: string;
  error?: string;
  warnings?: string[];
  findings?: { line?: number; message?: string; ruleGroup?: string; severity?: string }[];
};

type ReviewResult = {
  content: Array<{ type?: string; text?: string }>;
  details?: {
    fileEditReview?: {
      status?: string;
      warnings?: string[];
      reviewers?: AuditReviewer[];
    };
  };
};

type Fixture = {
  agentDir: string;
  projectDir: string;
  target: string;
  targetContent: string;
  fetchStub: typeof fetch;
  requests: string[];
  /** 每轮请求里的问题 id；用来验证一个文件的多条规则确实合并成一次请求。 */
  questionIdBatches: string[][];
};

const TARGET_CONTENT = "let result;\ntry {\n  result = run();\n} catch {\n  // ignore\n}\n";

/** 建好配置、规则文件和目标文件，并装一个按问题类型分派的 fetch 替身。 */
async function createFixture(options: {
  rules: string;
  noul?: number;
  chosenLine?: string;
  /** 按判断 id 覆盖 noul；未列出的用 options.noul。 */
  noulById?: Record<string, number>;
  /** 按行定位问题 id（`<判断 id>__line`）覆盖选项；未列出的用 options.chosenLine。 */
  lineById?: Record<string, string>;
}): Promise<Fixture> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-typesafe-"));
  const projectDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-typesafe-project-"));
  const rulesFile = join(projectDir, "no-swallowed-error.md");
  await writeFile(rulesFile, options.rules);
  await mkdir(join(agentDir, "extensions", "pi-tool-supervisor"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "pi-tool-supervisor", "config.json"),
    JSON.stringify({
      enabled: true,
      reviewers: [{ name: "taste", backend: "typesafe", typesafeModel: "jev-latest", rulesFiles: [rulesFile] }],
    }),
  );

  const requests: string[] = [];
  const questionIdBatches: string[][] = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string }> };
    const entries = Object.entries(body.questions);
    const types = entries.map(([, question]) => question.type);
    requests.push(types.join(","));
    questionIdBatches.push(entries.map(([id]) => id));
    if (types.every((type) => type === "noul")) {
      const answers = Object.fromEntries(entries.map(([id]) => [
        id,
        { type: "noul", noul: options.noulById?.[id] ?? options.noul ?? 0 },
      ]));
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }
    const answers = Object.fromEntries(entries.map(([id]) => [
      id,
      { type: "choice", choice: options.lineById?.[id] ?? options.chosenLine ?? "none", confidence: 0.95 },
    ]));
    return new Response(JSON.stringify({ answers }), { status: 200 });
  };

  return {
    agentDir,
    projectDir,
    target: join(projectDir, "example.ts"),
    targetContent: TARGET_CONTENT,
    fetchStub,
    requests,
    questionIdBatches,
  };
}

/** 走一次完整的 write 工具调用（tool_call + 真实写盘 + tool_result）。 */
async function runWriteTool(fixture: Fixture): Promise<ReviewResult> {
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const { pi, handlers } = createPi();
  piSupervisorExtension(pi);
  const input = { path: fixture.target, content: fixture.targetContent };
  const ctx = { cwd: fixture.projectDir };
  await handlers.get("tool_call")?.({ type: "tool_call", toolName: "write", toolCallId: "write-1", input }, ctx);
  await writeFile(fixture.target, fixture.targetContent);
  const result = await handlers.get("tool_result")?.({
    type: "tool_result",
    toolName: "write",
    toolCallId: "write-1",
    input,
    content: [{ type: "text", text: "Wrote file" }],
    details: {},
    isError: false,
  }, ctx);
  return result as ReviewResult;
}

/** 在临时改环境变量的前提下运行；无论成败都恢复原值。 */
async function withEnvironment(
  values: { agentDir?: string; apiKey?: string | undefined; fetchImpl?: typeof fetch },
  run: () => Promise<void>,
): Promise<void> {
  const previous = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    apiKey: process.env.TYPESAFE_API_KEY,
    fetch: globalThis.fetch,
  };
  if (values.agentDir !== undefined) process.env.PI_CODING_AGENT_DIR = values.agentDir;
  if (values.apiKey !== undefined) process.env.TYPESAFE_API_KEY = values.apiKey;
  if (values.fetchImpl !== undefined) globalThis.fetch = values.fetchImpl;
  try {
    await run();
  } finally {
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.apiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous.apiKey;
    globalThis.fetch = previous.fetch;
  }
}

test("typesafe reviewer 可以不写 model，配置保留 backend 和 TypeSafe 模型", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-typesafe-config-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    reviewers: [{ name: "taste", backend: "typesafe", rulesFiles: ["rules.md"] }],
  }));

  const loaded = loadFileEditReviewConfig(configFile);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.config.reviewers[0]?.backend, "typesafe");
  assert.equal(loaded.config.reviewers[0]?.typesafeModel, "jev-latest");
  assert.equal(loaded.config.reviewers[0]?.model, undefined);
});

test("backend 非法时丢弃该 reviewer 并给出警告", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-typesafe-backend-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    reviewers: [{ name: "taste", backend: "llm", typesafeModel: "jev-latest", rulesFiles: ["rules.md"] }],
  }));

  const loaded = loadFileEditReviewConfig(configFile);
  assert.deepEqual(loaded.config.reviewers, []);
  assert.match(loaded.warnings.join(" "), /backend/);
});

test("typesafe reviewer 同时写 model 时忽略该字段并警告", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-typesafe-model-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    reviewers: [{ name: "taste", backend: "typesafe", model: "provider/model", rulesFiles: ["rules.md"] }],
  }));

  const loaded = loadFileEditReviewConfig(configFile);
  assert.equal(loaded.config.reviewers[0]?.backend, "typesafe");
  assert.equal(loaded.config.reviewers[0]?.model, undefined);
  assert.match(loaded.warnings.join(" "), /忽略/);
});

test("typesafe reviewer 命中规则时阻断，并用规则自带的修复提示加行定位诊断", async () => {
  const fixture = await createFixture({ rules: SWALLOWED_ERROR_RULE, noul: 0.96, chosenLine: "5" });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;
    const reviewer = audit?.reviewers?.[0];

    assert.equal(audit?.status, "rejected");
    assert.equal(reviewer?.status, "rejected");
    assert.equal(reviewer?.model, "typesafe/jev-latest");
    // 一次 Noul 批量判断，命中后再一次 Choice 行定位。
    assert.deepEqual(fixture.requests, ["noul", "choice"]);
    assert.equal(reviewer?.findings?.[0]?.line, 5);
    assert.equal(reviewer?.findings?.[0]?.severity, "error");
    assert.match(reviewer?.findings?.[0]?.message ?? "", /把失败显式抛给调用方/);
    assert.match(reviewer?.summary ?? "", /no-swallowed-error=0\.96/);
    // 拒绝必须送到 Agent 的 tool result 里，而不是只留在审计卡片上。
    assert.equal(result.content.length, 2);
    assert.match(result.content[1]?.text ?? "", /命中代码：\/\/ ignore/);
  });
});

test("typesafe reviewer 未命中规则时通过，且不发第二次请求", async () => {
  const fixture = await createFixture({ rules: SWALLOWED_ERROR_RULE, noul: 0.2 });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "passed");
    assert.deepEqual(audit?.reviewers?.[0]?.findings, []);
    assert.deepEqual(fixture.requests, ["noul"]);
    // 通过的审查不注入 Agent 上下文。
    assert.equal(result.content.length, 1);
  });
});

test("缺少 TypeSafe API key 时审计报 failed，但不注入 Agent 也不阻断", async () => {
  const fixture = await createFixture({ rules: SWALLOWED_ERROR_RULE, noul: 0.96 });
  const failingFetch: typeof fetch = async () => {
    throw new Error("不应该发起请求");
  };
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: undefined, fetchImpl: failingFetch }, async () => {
    delete process.env.TYPESAFE_API_KEY;
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "failed");
    assert.match(audit?.reviewers?.[0]?.error ?? "", /TYPESAFE_API_KEY/);
    assert.equal(result.content.length, 1);
  });
});

type ConfigCommand = {
  handler: (args: string, ctx: unknown) => Promise<void>;
};

test("配置 UI 可以把 model reviewer 切换到 typesafe 引擎并持久化", async () => {
  const { default: piSupervisorExtension } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-typesafe-ui-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const configDirectory = join(agentDir, "extensions", "pi-tool-supervisor");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "config.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      reviewers: [{ name: "taste", model: "provider/model", rulesFile: "rules.md" }],
    }));

    const commands = new Map<string, ConfigCommand>();
    const pi = {
      getAllTools: () => [],
      registerEntryRenderer: () => undefined,
      appendEntry: () => undefined,
      registerCommand: (name: string, command: ConfigCommand) => commands.set(name, command),
      on: () => undefined,
    } as unknown as Parameters<typeof piSupervisorExtension>[0];
    piSupervisorExtension(pi);

    let editorVisits = 0;
    let switched = false;
    const ctx = {
      hasUI: true,
      ui: {
        select: async (_title: string, choices: string[]) => {
          if (choices.includes("TypeSafe 判断")) {
            switched = true;
            return "TypeSafe 判断";
          }
          const reviewerRow = choices.find((choice) => choice.startsWith("● "));
          if (reviewerRow) return editorVisits++ === 0 ? reviewerRow : undefined;
          if (!switched) {
            const backendRow = choices.find((choice) => choice.startsWith("审查引擎："));
            if (backendRow) return backendRow;
          }
          return "返回";
        },
        input: async (_title: string, current: string) => current,
        confirm: async () => false,
        notify: () => undefined,
      },
    };

    await commands.get("config:tool-supervisor")?.handler("", ctx);
    const saved = JSON.parse(await readFile(configPath, "utf8")) as {
      reviewers: { model?: string; backend?: string; typesafeModel?: string }[];
    };

    assert.equal(saved.reviewers[0]?.backend, "typesafe");
    assert.equal(saved.reviewers[0]?.typesafeModel, "jev-latest");
    // 切到 typesafe 后不该再留一个对话模型字段，否则配置自相矛盾。
    assert.equal(saved.reviewers[0]?.model, undefined);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("warning 级规则命中时只入审计、不阻断也不注入 Agent", async () => {
  const warningRule = SWALLOWED_ERROR_RULE.replace("severity: error", "severity: warning");
  const fixture = await createFixture({ rules: warningRule, noul: 0.96, chosenLine: "5" });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "passed");
    assert.equal(audit?.reviewers?.[0]?.findings?.[0]?.severity, "warning");
    assert.match(audit?.reviewers?.[0]?.summary ?? "", /都不是阻断级别/);
    // 非阻断命中不需要行定位，也不需要打扰 Agent。
    assert.deepEqual(fixture.requests, ["noul"]);
    assert.equal(result.content.length, 1);
  });
});

test("规则文件缺少判据时报 failed 并说明原因，不发起 TypeSafe 请求", async () => {
  const fixture = await createFixture({ rules: PROSE_ONLY_RULE });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "failed");
    assert.match(audit?.reviewers?.[0]?.error ?? "", /判据/);
    assert.deepEqual(fixture.requests, []);
  });
});

test("一个文件里的多条规则合并成一次请求，并各自报出独立的规则名和行", async () => {
  const fixture = await createFixture({
    rules: MULTI_BLOCK_RULE,
    noulById: { "no-swallowed-error": 0.96, "no-magic-number": 0.93 },
    lineById: { "no-swallowed-error__line": "5" },
  });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;
    const reviewer = audit?.reviewers?.[0];

    assert.equal(audit?.status, "rejected");
    // 两条规则一次 Noul 批量问完；只有 error 级那条需要行定位。
    assert.deepEqual(fixture.questionIdBatches, [["no-swallowed-error", "no-magic-number"], ["no-swallowed-error__line"]]);
    assert.deepEqual(fixture.requests, ["noul,noul", "choice"]);
    // 两条规则各自得到一条 finding，而不是合并成一条。
    assert.deepEqual(reviewer?.findings?.map((finding) => finding.ruleGroup), ["no-swallowed-error", "no-magic-number"]);
    assert.deepEqual(reviewer?.findings?.map((finding) => finding.severity), ["error", "warning"]);
    assert.equal(reviewer?.findings?.[0]?.line, 5);
    assert.match(reviewer?.findings?.[0]?.message ?? "", /把失败显式抛给调用方/);
    assert.match(reviewer?.findings?.[1]?.message ?? "", /把魔法数字提取成具名常量/);
    // summary 必须两条都列出来，否则看不出哪条命中。
    assert.match(reviewer?.summary ?? "", /no-swallowed-error=0\.96/);
    assert.match(reviewer?.summary ?? "", /no-magic-number=0\.93/);
  });
});

test("多规则文件里只有 warning 级命中时不阻断，也不发第二次请求", async () => {
  const fixture = await createFixture({
    rules: MULTI_BLOCK_RULE,
    noulById: { "no-swallowed-error": 0.2, "no-magic-number": 0.93 },
  });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "passed");
    // 两条规则仍然合并成一次请求，只是都不需要行定位。
    assert.deepEqual(fixture.requests, ["noul,noul"]);
    assert.deepEqual(audit?.reviewers?.[0]?.findings?.map((finding) => finding.ruleGroup), ["no-magic-number"]);
    assert.equal(result.content.length, 1);
  });
});

test("多规则文件里某个块缺判据时报 failed，并指名是哪个块", async () => {
  const brokenBlockRule = MULTI_BLOCK_RULE.replace("## 判据\ntrue: 新增行直接写了魔法数字\nfalse: 已经提取成具名常量\n", "");
  const fixture = await createFixture({ rules: brokenBlockRule, noul: 0.96, chosenLine: "5" });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "rejected");
    // 阻断和“某个块缺判据”同时发生：阻断优先，但缺判据仍然要在 warnings 里指名。
    assert.match(audit?.reviewers?.[0]?.warnings?.join(" ") ?? "", /no-magic-number/);
  });
});
