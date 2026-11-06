import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFileEditReviewConfig, reviewerModelLabel, type FileEditReviewAudit } from "../src/review-utils.ts";
import { createScriptedUi, down, ENTER } from "./panel-driver.ts";

process.env.PI_EXTENSIONS_LOCALE = "en-US";
const TOKEN = "synthetic-decision-token";
type Handler = (...args: any[]) => any;
type Question = { type: string; criteria?: Record<string, string>; instructions: string };
type RequestBody = { model: string; questions: { name: string; type: string; choices?: { value: string }[] }[]; input: string };
type ToolResult = { content: unknown[]; isError: boolean; details: { marker: string; fileEditReview: FileEditReviewAudit } };

type FixtureOptions = {
  rules?: number; noul?: number; hitOnly?: string; model?: string; trigger?: "before" | "after";
  signal?: AbortSignal; timeoutSeconds?: number;
  response?: (body: RequestBody, response: ServerResponse, request: IncomingMessage) => void;
};

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-decisions-review-"));
  const configDir = join(directory, "extensions", "pi-tool-supervisor");
  const configPath = join(configDir, "config.json");
  const rulesFile = join(directory, "quality.md");
  const target = join(directory, "example.ts");
  const requests: RequestBody[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as RequestBody;
    requests.push(body);
    paths.push(request.url!);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (options.response) return options.response(body, response, request);
    const answers = body.questions.map((question) => question.type === "predicate"
      ? { type: "predicate", name: question.name, probability: options.hitOnly ? (question.name === options.hitOnly ? 0.96 : 0.1) : options.noul ?? 0.1 }
      : { type: "choice", name: question.name, choice: "2", confidence: 0.95, probabilities: question.choices!.map(({ value }) => ({ value, probability: value === "2" ? 0.97 : value === "none" ? 0.03 : 0 })) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ model: body.model, answers }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/openai/v1`;
  const prior = Object.fromEntries(["PI_CODING_AGENT_DIR", "DECISIONS_TEST_TOKEN"].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.DECISIONS_TEST_TOKEN = TOKEN;
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rename(directory, `${directory}.trash`);
  });
  await mkdir(configDir, { recursive: true });
  await writeFile(rulesFile, `---\nname: quality\nthreshold: 0.85\n---\n## Required\n\n${Array.from({ length: options.rules ?? 2 }, (_, i) => `${i + 1}. **Rule ${i + 1}**: Do not swallow errors.`).join("\n")}\n`);
  await writeFile(configPath, JSON.stringify({
    enabled: true, timeoutSeconds: options.timeoutSeconds ?? 10,
    openaiDecisions: { baseUrl, apiKeyEnv: "DECISIONS_TEST_TOKEN" },
    reviewers: [{ name: "quality", backend: "openai-decisions", openaiDecisionsModel: options.model ?? "gpt-6-luna",
      rulesFiles: [rulesFile], tools: ["write"], trigger: options.trigger ?? "after" }],
  }));
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  const audits: unknown[] = [];
  const pi = {
    getAllTools: () => [{ name: "write" }],
    registerEntryRenderer: () => undefined,
    appendEntry: (_name: unknown, audit: unknown) => audits.push(audit),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  const { default: supervisor } = await import("../src/index.ts");
  supervisor(pi);
  const ctx = { cwd: directory, signal: options.signal };
  let nextId = 0;
  async function runWrite() {
    const toolCallId = `write-${nextId++}`;
    const content = `const version = ${nextId};\ntry { run(); } catch {}\n`;
    const input = { path: target, content };
    const gate = await handlers.get("tool_call")!({ type: "tool_call", toolName: "write", toolCallId, input }, ctx);
    if (gate?.block) return { gate, result: undefined };
    await writeFile(target, content);
    const result = await handlers.get("tool_result")!({ type: "tool_result", toolName: "write", toolCallId, input,
      content: [{ type: "text", text: "Wrote file" }], details: { marker: "native" }, isError: false,
    }, ctx) as ToolResult;
    return { gate, result };
  }
  return { directory, configPath, rulesFile, target, baseUrl, requests, paths, handlers, commands, audits, runWrite };
}

test("real tool events use Decisions predicates and line choices while preserving native output", async (t) => {
  const f = await fixture(t, { hitOnly: "rule_2" });
  const { result } = await f.runWrite();
  const audit = result!.details.fileEditReview;
  assert.equal(audit.status, "rejected");
  assert.equal(audit.reviewers[0].model, "openai-decisions/gpt-6-luna");
  assert.deepEqual(audit.reviewers[0].findings?.map(f => [f.ruleGroup, f.line]), [["Required 2 Rule 2", 2]]);
  assert.deepEqual(f.requests.map(body => body.questions.map(q => q.type)), [["predicate", "predicate"], ["choice"]]);
  assert.ok(f.paths.every(path => path === "/openai/v1/decisions"));
  assert.equal(result!.details.marker, "native");
  assert.equal(result!.isError, false);
  assert.equal(await readFile(f.target, "utf8"), "const version = 1;\ntry { run(); } catch {}\n");
  assert.ok(!JSON.stringify(audit).includes(TOKEN));
});

test("unmatched rules pass, and a refusal remains a failed review rather than a pass", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.runWrite()).result!.details.fileEditReview.status, "passed");
  const refused = await fixture(t, { response: (body, response) => {
    response.end(JSON.stringify({ answers: body.questions.map(q => ({ name: q.name, type: "refusal" })) }));
  } });
  const { result } = await refused.runWrite();
  assert.equal(result!.details.fileEditReview.status, "failed");
  assert.match(result!.details.fileEditReview.reviewers[0].error ?? "", /refused/i);
});

test("before-tool rejection stops the write and a config edit affects the next tool call", async (t) => {
  const f = await fixture(t, { trigger: "before", noul: 0.98 });
  const blocked = await f.runWrite();
  assert.equal(blocked.gate.block, true);
  await assert.rejects(readFile(f.target, "utf8"), { code: "ENOENT" });
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  config.reviewers[0].enabled = false;
  await writeFile(f.configPath, JSON.stringify(config));
  const next = await f.runWrite();
  assert.equal(Boolean(next.gate?.block), false);
  assert.match(await readFile(f.target, "utf8"), /version = 2/);
});

test("the existing panel selects Decisions and the next tool call uses its configured gateway", async (t) => {
  initTheme("dark");
  const f = await fixture(t);
  await writeFile(f.configPath, JSON.stringify({ enabled: true,
    openaiDecisions: { baseUrl: f.baseUrl, apiKeyEnv: "DECISIONS_TEST_TOKEN" },
    reviewers: [{ name: "quality", model: "provider/model", rulesFiles: [f.rulesFile], tools: ["write"] }],
  }));
  const ui = createScriptedUi([
    [...down(12), ENTER],
    [...down(2), ENTER, ...down(3), ENTER, "\u001B"],
    ["\u001B"],
  ]);
  await f.commands.get("config:tool-supervisor")!.handler("", {
    hasUI: true, modelRegistry: { getAvailable: () => [] },
    ui: { custom: ui.custom, confirm: async () => false, notify: () => undefined },
  });
  const saved = loadFileEditReviewConfig(f.configPath);
  assert.deepEqual(saved.warnings, []);
  assert.equal(saved.config.reviewers[0].backend, "openai-decisions");
  assert.equal(saved.config.openaiDecisions?.baseUrl, f.baseUrl);
  assert.equal((await f.runWrite()).result!.details.fileEditReview.reviewers[0].model, "openai-decisions/gpt-6-luna");
});
