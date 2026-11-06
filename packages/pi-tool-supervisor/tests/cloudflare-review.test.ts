import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFileEditReviewConfig, reviewerModelLabel, type FileEditReviewAudit } from "../src/review-utils.ts";
import { createScriptedUi, down, ENTER } from "./panel-driver.ts";

process.env.PI_EXTENSIONS_LOCALE = "en-US";
const ACCOUNT = "a".repeat(32);
const TOKEN = "synthetic-cloudflare-token";
type Handler = (...args: any[]) => any;
type Question = { type: string; criteria?: Record<string, string>; instructions: string };
type RequestBody = { model: string; questions: Record<string, Question>; state: unknown };
type ToolResult = { content: unknown[]; isError: boolean; details: { marker: string; fileEditReview: FileEditReviewAudit } };

type FixtureOptions = {
  rules?: number; noul?: number; hitOnly?: string; model?: "clef" | "clef-flash"; trigger?: "before" | "after";
  signal?: AbortSignal; timeoutSeconds?: number;
  response?: (body: RequestBody, response: ServerResponse, request: IncomingMessage) => void;
};

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloudflare-review-"));
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
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id,
      question.type === "noul"
        ? { type: "noul", noul: options.hitOnly ? (id === options.hitOnly ? 0.96 : 0.1) : options.noul ?? 0.1 }
        : { type: "choice", choice: "2", confidence: 0.95, probabilities: { "2": 0.97, none: 0.03 } },
    ]));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ success: true, result: { model: body.model, answers } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/client/v4`;
  const prior = Object.fromEntries(["PI_CODING_AGENT_DIR", "CLOUDFLARE_ACCOUNT_ID", "CF_TEST_TOKEN"].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT;
  process.env.CF_TEST_TOKEN = TOKEN;
  t.after(async () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(configDir, { recursive: true });
  await writeFile(rulesFile, `---\nname: quality\nthreshold: 0.85\n---\n## Required\n\n${Array.from({ length: options.rules ?? 2 }, (_, i) => `${i + 1}. **Rule ${i + 1}**: Do not swallow errors.`).join("\n")}\n`);
  await writeFile(configPath, JSON.stringify({
    enabled: true, timeoutSeconds: options.timeoutSeconds ?? 10,
    cloudflare: { baseUrl, tokenEnv: "CF_TEST_TOKEN" },
    reviewers: [{ name: "quality", backend: "cloudflare", cloudflareModel: options.model ?? "clef-flash",
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

for (const model of ["clef-flash", "clef"] as const) {
  test(`${model}: real tool events use Noul then Choice, preserving rule names and added lines`, async (t) => {
    const f = await fixture(t, { model, hitOnly: "rule_2" });
    const { result } = await f.runWrite();
    const audit = result!.details.fileEditReview;
    assert.equal(audit.status, "rejected");
    assert.equal(audit.reviewers[0].model, `cloudflare/${model}`);
    assert.deepEqual(audit.reviewers[0].findings?.map((finding) => [finding.ruleGroup, finding.line]), [["Required 2 Rule 2", 2]]);
    assert.deepEqual(f.requests.map((body) => Object.values(body.questions).map((question) => question.type)), [["noul", "noul"], ["choice"]]);
    assert.ok(f.paths.every((path) => path.endsWith(`/@cf/cloudflare/${model}`)));
    assert.equal(result!.details.marker, "native");
    assert.equal(result!.isError, false);
    assert.equal(await readFile(f.target, "utf8"), "const version = 1;\ntry { run(); } catch {}\n");
    assert.ok(!JSON.stringify(audit).includes(TOKEN));
  });
}

test("unmatched rules pass and preserve the native result content", async (t) => {
  const f = await fixture(t);
  const { result } = await f.runWrite();
  assert.equal(result!.details.fileEditReview.status, "passed");
  assert.deepEqual(result!.content, [{ type: "text", text: "Wrote file" }]);
  assert.equal(f.requests.length, 1);
});

test("65 hit rules produce all findings after both judgment and localization batches", async (t) => {
  const f = await fixture(t, { rules: 65, noul: 0.96 });
  const { result } = await f.runWrite();
  const reviewer = result!.details.fileEditReview.reviewers[0];
  assert.equal(reviewer.status, "rejected");
  assert.equal(reviewer.findings!.length, 65);
  assert.ok(reviewer.findings!.every((finding) => finding.line === 2));
  assert.deepEqual(f.requests.map((body) => Object.keys(body.questions).length), [64, 1, 64, 1]);
  assert.equal(reviewer.findings!.at(-1)!.ruleGroup, "Required 65 Rule 65");
});

for (const [name, status, body] of [
  ["success false", 200, { success: false, errors: [{ code: 10000, message: TOKEN }] }],
  ["authentication", 401, { success: false }], ["region", 451, { success: false }],
  ["invalid JSON", 200, "{"], ["missing answer", 200, { success: true, result: { answers: {} } }],
] as const) {
  test(`${name} is audited failed and before execution stays open`, async (t) => {
    const f = await fixture(t, { trigger: "before", response: (_body, response) => {
      response.statusCode = status;
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    } });
    const { gate, result } = await f.runWrite();
    assert.ok(!gate?.block);
    assert.equal(result!.details.fileEditReview.status, "failed");
    assert.equal(result!.details.fileEditReview.reviewers[0].model, "cloudflare/clef-flash");
    assert.equal(result!.content.length, 1);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.equal(f.requests.length, 1);
  });
}

test("before rejection blocks the write and records the selected provider", async (t) => {
  const f = await fixture(t, { trigger: "before", noul: 0.96 });
  const { gate, result } = await f.runWrite();
  assert.equal(gate.block, true);
  assert.match(gate.reason, /Rule 1/);
  assert.equal(result, undefined);
  await assert.rejects(readFile(f.target), /ENOENT/);
  assert.match(JSON.stringify(f.audits), /cloudflare\/clef-flash/);
});

test("parent cancellation during judgment stops later batches and localization", async (t) => {
  const parent = new AbortController();
  const f = await fixture(t, { rules: 65, signal: parent.signal, response: (_body, response) => {
    parent.abort();
    response.end(JSON.stringify({ success: true, result: { answers: {} } }));
  } });
  const { result } = await f.runWrite();
  assert.equal(result!.details.fileEditReview.reviewers[0].status, "skipped");
  assert.equal(f.requests.length, 1);
  assert.equal(result!.content.length, 1);
});

test("judgment and localization share a reviewer deadline", async (t) => {
  const f = await fixture(t, { timeoutSeconds: 1, response: (body, response) => {
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id,
      question.type === "noul" ? { type: "noul", noul: 0.96 } : { type: "choice", choice: "2", confidence: 0.95 },
    ]));
    const timer = setTimeout(() => response.end(JSON.stringify({ success: true, result: { answers } })), 650);
    response.on("close", () => clearTimeout(timer));
  } });
  const start = performance.now();
  const { result } = await f.runWrite();
  assert.equal(result!.details.fileEditReview.status, "rejected");
  assert.match(result!.details.fileEditReview.reviewers[0].warnings!.join(" "), /timed out/);
  assert.ok(performance.now() - start < 1_250);
  assert.equal(f.requests.length, 2);
});

test("panel edits connection, switches backend and model, and affects the next tool call immediately", async (t) => {
  initTheme("dark");
  const f = await fixture(t);
  await writeFile(f.configPath, JSON.stringify({ enabled: true,
    reviewers: [{ name: "quality", model: "provider/model", rulesFiles: [f.rulesFile], tools: ["write"] }],
  }));
  // Set two connection fields in one open panel; then switch backend and choose Clef in the same reviewer page.
  const ui = createScriptedUi([
    [...down(6), ENTER, f.baseUrl, ENTER, ...down(3), ENTER, "CF_TEST_TOKEN", ENTER, ...down(3), ENTER],
    [...down(2), ENTER, ...down(2), ENTER, ...down(1), ENTER, ...down(1), ENTER, "\u001B"],
    ["\u001B"],
  ]);
  await f.commands.get("config:tool-supervisor")!.handler("", {
    hasUI: true, modelRegistry: { getAvailable: () => [] },
    ui: { custom: ui.custom, confirm: async () => false, notify: () => undefined },
  });
  const config = loadFileEditReviewConfig(f.configPath);
  assert.deepEqual(config.warnings, []);
  assert.equal(config.config.cloudflare?.baseUrl, f.baseUrl);
  assert.equal(config.config.cloudflare?.tokenEnv, "CF_TEST_TOKEN");
  assert.equal(config.config.reviewers[0].backend, "cloudflare");
  assert.equal(config.config.reviewers[0].cloudflareModel, "clef");
  assert.ok(!(await readFile(f.configPath, "utf8")).includes(TOKEN));
  const { result } = await f.runWrite();
  assert.equal(result!.details.fileEditReview.status, "passed");
  assert.equal(f.requests[0].model, "clef");
});

test("configuration preserves legacy defaults and validates Cloudflare model selection", async (t) => {
  const f = await fixture(t);
  const write = async (reviewers: unknown[]) => {
    await writeFile(f.configPath, JSON.stringify({ reviewers }));
    return loadFileEditReviewConfig(f.configPath);
  };
  const loaded = await write([
    { name: "legacy", model: "provider/model", rulesFile: "rules.md" },
    { name: "jev", backend: "typesafe", rulesFile: "rules.md" },
    { name: "clef", backend: "cloudflare", rulesFile: "rules.md" },
  ]);
  assert.deepEqual(loaded.warnings, []);
  assert.deepEqual(loaded.config.reviewers.map(reviewerModelLabel), ["provider/model", "typesafe/jev-latest", "cloudflare/clef-flash"]);
  const invalid = await write([{ backend: "cloudflare", cloudflareModel: "unsupported", rulesFile: "rules.md" }]);
  assert.equal(invalid.config.reviewers.length, 0);
  assert.match(invalid.warnings.join(" "), /cloudflareModel/);
});
