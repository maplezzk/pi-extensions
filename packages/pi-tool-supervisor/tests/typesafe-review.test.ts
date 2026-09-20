import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileEditReviewConfig } from "../src/review-utils.ts";

process.env.PI_EXTENSIONS_LOCALE = "zh-CN";

/**
 * 照抄真规则文件的形态：front matter + 元指令段落 + 编号条款 + severity 标注 + 粗体标题。
 * 规则文件本身不动，typesafe 直接读它。
 */
const SWALLOWED_ERROR_RULE = `---
name: js-quality
threshold: 0.85
---
# JS/TS 代码质量

## 归属与 severity（优先于以上条款）

1. \`ruleGroup\` 只能填本文件里原样出现的条款名或编号。
2. 禁止越界：不要报本文件没写的规则。
3. \`severity\` 必须按条款前的标注填写。

## 必须遵守

1. [error] **禁止静默吞异常**：新增行捕获错误后静默继续，例如空 catch 或用默认值掩盖失败。
   应通过抛出或记录日志报告失败。
`;

/** 没有任何编号条款的文件：本后端切不出规则，必须报错而不是静默通过。 */
const CLAUSE_FREE_RULE = `# 只有散文规则

不要把错误吞掉。
`;

/** 一个文件里两条规则：被告知哪一条命中，各自带自己的行号。 */
const MULTI_CLAUSE_RULE = `---
name: js-quality
threshold: 0.85
---
# JS/TS 代码质量

## 必须遵守

1. [error] **禁止静默吞异常**：新增行捕获错误后静默继续，例如空 catch 或用默认值掩盖失败。
2. [warning] **禁止魔法值**：业务逻辑中的非显而易见数字必须提取为有语义的常量。
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
  /** 第二个规则文件；用来验证多个规则文件合并成一次请求时判断 id 不重号。 */
  secondRules?: { name: string; content: string };
  noul?: number;
  chosenLine?: string;
  /** 按判断 id 覆盖 noul；未列出的用 options.noul。 */
  noulById?: Record<string, number>;
  /** 按行定位问题 id（`<判断 id>__line`）覆盖选项；未列出的用 options.chosenLine。 */
  lineById?: Record<string, string>;
  /** 写入 config.json 顶层的 typesafe 连接设置；用来验证 key 不经环境变量也能生效。 */
  typesafe?: { apiKey?: string; endpoint?: string };
}): Promise<Fixture> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-typesafe-"));
  const projectDir = await mkdtemp(join(tmpdir(), "pi-tool-supervisor-typesafe-project-"));
  const rulesFile = join(projectDir, "no-swallowed-error.md");
  await writeFile(rulesFile, options.rules);
  const rulesFiles = [rulesFile];
  if (options.secondRules) {
    const secondFile = join(projectDir, options.secondRules.name);
    await writeFile(secondFile, options.secondRules.content);
    rulesFiles.push(secondFile);
  }
  await mkdir(join(agentDir, "extensions", "pi-tool-supervisor"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "pi-tool-supervisor", "config.json"),
    JSON.stringify({
      enabled: true,
      ...(options.typesafe === undefined ? {} : { typesafe: options.typesafe }),
      reviewers: [{ name: "taste", backend: "typesafe", typesafeModel: "jev-latest", rulesFiles }],
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

test("typesafe reviewer 命中规则时阻断，并用条款正文加行定位诊断", async () => {
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
    // 本后端不分级：命中即阻断。
    assert.equal(reviewer?.findings?.[0]?.severity, "error");
    // 规则名取自条款自己的叫法，所以能看出是文件里哪一条。
    assert.equal(reviewer?.findings?.[0]?.ruleGroup, "必须遵守 1 禁止静默吞异常");
    assert.match(reviewer?.findings?.[0]?.message ?? "", /应通过抛出或记录日志报告失败/);
    assert.match(reviewer?.summary ?? "", /必须遵守 1 禁止静默吞异常=0\.96/);
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

test("条款里的 [warning] 标注不再降级：定义即遵守，照样阻断", async () => {
  // 旧行为是 [warning] 只提示不阻断；本后端不分级，所以同一条款要阻断。
  const warningRule = SWALLOWED_ERROR_RULE.replace("[error] **禁止静默吞异常**", "[warning] **禁止静默吞异常**");
  const fixture = await createFixture({ rules: warningRule, noul: 0.96, chosenLine: "5" });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "rejected");
    assert.equal(audit?.reviewers?.[0]?.findings?.[0]?.severity, "error");
    // 判据里不能留 [warning]，否则行为和文案矛盾。
    assert.doesNotMatch(audit?.reviewers?.[0]?.findings?.[0]?.message ?? "", /\[warning\]/);
    // 阻断就要行定位，也要送到 Agent 的 tool result。
    assert.deepEqual(fixture.requests, ["noul", "choice"]);
    assert.equal(result.content.length, 2);
  });
});

test("规则文件切不出编号条款时报 failed 并说明原因，不发起 TypeSafe 请求", async () => {
  const fixture = await createFixture({ rules: CLAUSE_FREE_RULE });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "failed");
    assert.match(audit?.reviewers?.[0]?.error ?? "", /编号条款/);
    assert.deepEqual(fixture.requests, []);
  });
});

test("一个文件里的多条规则合并成一次请求，并各自报出是哪条命中", async () => {
  const fixture = await createFixture({
    rules: MULTI_CLAUSE_RULE,
    noulById: { rule_1: 0.96, rule_2: 0.93 },
    lineById: { rule_1__line: "5" },
  });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;
    const reviewer = audit?.reviewers?.[0];

    assert.equal(audit?.status, "rejected");
    // 两条规则一次 Noul 批量问完；不分级，两条命中都要行定位。
    assert.deepEqual(fixture.questionIdBatches, [["rule_1", "rule_2"], ["rule_1__line", "rule_2__line"]]);
    assert.deepEqual(fixture.requests, ["noul,noul", "choice,choice"]);
    // 两条规则各自得到一条 finding，而不是合并成一条。
    assert.deepEqual(reviewer?.findings?.map((finding) => finding.ruleGroup), [
      "必须遵守 1 禁止静默吞异常",
      "必须遵守 2 禁止魔法值",
    ]);
    assert.deepEqual(reviewer?.findings?.map((finding) => finding.severity), ["error", "error"]);
    assert.equal(reviewer?.findings?.[0]?.line, 5);
    assert.match(reviewer?.findings?.[0]?.message ?? "", /新增行捕获错误后静默继续/);
    assert.match(reviewer?.findings?.[1]?.message ?? "", /必须提取为有语义的常量/);
    // summary 必须两条都列出来，否则看不出哪条命中。
    assert.match(reviewer?.summary ?? "", /必须遵守 1 禁止静默吞异常=0\.96/);
    assert.match(reviewer?.summary ?? "", /必须遵守 2 禁止魔法值=0\.93/);
  });
});

test("多规则文件里只有一条命中时，只报那一条", async () => {
  const fixture = await createFixture({
    rules: MULTI_CLAUSE_RULE,
    noulById: { rule_1: 0.2, rule_2: 0.93 },
    lineById: { rule_2__line: "5" },
  });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "rejected");
    // 两条规则仍然合并成一次请求；只有命中那条需要行定位。
    assert.deepEqual(fixture.requests, ["noul,noul", "choice"]);
    assert.deepEqual(audit?.reviewers?.[0]?.findings?.map((finding) => finding.ruleGroup), ["必须遵守 2 禁止魔法值"]);
  });
});

test("多个规则文件的条款编号各自从 1 开始时不重号，也不报重复编号警告", async () => {
  // 真实配置就是多个规则文件挂在一个 reviewer 上，每个文件都从 1 开始编号。
  const fixture = await createFixture({
    rules: SWALLOWED_ERROR_RULE,
    secondRules: { name: "second-quality.md", content: MULTI_CLAUSE_RULE },
    noul: 0.2,
  });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const audit = result.details?.fileEditReview;

    assert.equal(audit?.status, "passed");
    // 前缀只解决跨文件重号，条数不变，仍然合并成一次请求。
    assert.deepEqual(fixture.questionIdBatches, [["f1_rule_1", "f2_rule_1", "f2_rule_2"]]);
    assert.equal(audit?.reviewers?.[0]?.warnings, undefined);
    assert.doesNotMatch(JSON.stringify(audit), /编号都是/);
  });
});

test("config.json 里配的 API Key 不经环境变量也能发起审查", async () => {
  const fixture = await createFixture({
    rules: SWALLOWED_ERROR_RULE,
    noul: 0.96,
    typesafe: { apiKey: "apik-from-config" },
  });
  // 环境变量刻意清空：key 只能来自 config.json。
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: undefined, fetchImpl: fixture.fetchStub }, async () => {
    delete process.env.TYPESAFE_API_KEY;
    const result = await runWriteTool(fixture);
    const reviewer = result.details?.fileEditReview?.reviewers?.[0];

    assert.equal(reviewer?.status, "rejected");
    assert.deepEqual(fixture.requests, ["noul", "choice"]);
  });
});

test("config.json 里没配 key 且环境变量也没有时报 failed，不当作通过", async () => {
  const fixture = await createFixture({ rules: SWALLOWED_ERROR_RULE, noul: 0.96 });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: undefined, fetchImpl: fixture.fetchStub }, async () => {
    delete process.env.TYPESAFE_API_KEY;
    const result = await runWriteTool(fixture);
    const reviewer = result.details?.fileEditReview?.reviewers?.[0];

    assert.equal(reviewer?.status, "failed");
    assert.match(reviewer?.error ?? "", /TYPESAFE_API_KEY/);
    assert.deepEqual(fixture.requests, []);
  });
});

test("同一条规则重复命中时不会静默丢掉后续命中", async () => {
  const fixture = await createFixture({
    rules: MULTI_CLAUSE_RULE,
    noulById: { rule_1: 0.96, rule_2: 0.95 },
    lineById: { rule_1__line: "5", rule_2__line: "4" },
  });
  await withEnvironment({ agentDir: fixture.agentDir, apiKey: "apik-test", fetchImpl: fixture.fetchStub }, async () => {
    const result = await runWriteTool(fixture);
    const reviewer = result.details?.fileEditReview?.reviewers?.[0];

    // 两条命中的行号必须各自独立，不能只看第一条。
    assert.deepEqual(reviewer?.findings?.map((finding) => finding.line), [5, 4]);
  });
});
