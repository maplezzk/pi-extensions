import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createJudgeModelInvoker,
  resolveJudgeModel,
  type JudgeAuth,
  type JudgeCompletion,
  type JudgeModelSource,
  type PiModel,
} from "../src/judge-model.ts";
import type { TurnSnapshot } from "../src/session-context.ts";

/** 判定输入快照。 */
const SNAPSHOT: TurnSnapshot = { userRequest: "任务", finalOutput: "做了一半", toolTrace: [] };

/** 测试用最小模型对象：字段完整以满足 Pi 的模型契约。 */
const TEST_MODEL: PiModel = {
  id: "judge-model",
  name: "Judge Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 4096,
};

/** 一次 completion 调用的可观察入参。 */
interface CapturedCall {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  apiKey?: string;
  signal?: AbortSignal;
}

/** 组装判定模型来源，默认注入可用的模型与鉴权。 */
function sourceWith(overrides: Partial<JudgeModelSource> = {}): JudgeModelSource {
  return {
    configuredModel: "",
    sessionModel: TEST_MODEL,
    findModel: () => TEST_MODEL,
    resolveAuth: async (): Promise<JudgeAuth> => ({ ok: true, apiKey: "key" }),
    ...overrides,
  };
}

/** 记录每次 completion 入参的测试替身。 */
function capturingCompletion(): { completion: JudgeCompletion; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const completion: JudgeCompletion = async (options) => {
    calls.push({
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      maxTokens: options.maxTokens,
      apiKey: options.auth.apiKey,
      signal: options.signal,
    });
    return { text: '{"decision":"stop","confidence":1,"reason":"完成"}', stopReason: "stop" };
  };
  return { completion, calls };
}

test("未配置模型时用当前会话模型，配置后按 provider/modelId 查找", () => {
  const source = {
    configuredModel: "",
    sessionModel: "session-model",
    findModel: (provider: string, modelId: string) => `${provider}/${modelId}`,
  };
  assert.equal(resolveJudgeModel(source), "session-model");

  assert.equal(resolveJudgeModel({ ...source, configuredModel: "openai/gpt-5-mini" }), "openai/gpt-5-mini");
  assert.equal(resolveJudgeModel({ ...source, configuredModel: "  " }), "session-model");

  const missing = { ...source, configuredModel: "openai/unknown", findModel: () => undefined };
  assert.equal(resolveJudgeModel(missing), undefined);
});

test("模型解析在会话没有模型且未配置时返回 undefined", () => {
  assert.equal(resolveJudgeModel({ configuredModel: "", sessionModel: undefined, findModel: () => undefined }), undefined);
});

test("判定调用把提示词与鉴权信息交给底层 completion", async () => {
  const { completion, calls } = capturingCompletion();
  const controller = new AbortController();
  const invoke = createJudgeModelInvoker({ source: sourceWith(), completion });

  const response = await invoke({ snapshot: SNAPSHOT, signal: controller.signal });

  assert.equal(response.stopReason, "stop");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiKey, "key");
  assert.equal(calls[0].signal, controller.signal);
  assert.ok(calls[0].maxTokens > 0);
  assert.match(calls[0].systemPrompt, /提前停止|premature/i);
  assert.match(calls[0].userPrompt, /<user-request>\n任务\n<\/user-request>/);
});

test("响应文本只取文本块", async () => {
  const invoke = createJudgeModelInvoker({
    source: sourceWith(),
    completion: async () => ({
      text: "第一段\n第二段",
      stopReason: "stop",
    }),
  });
  assert.equal((await invoke({ snapshot: SNAPSHOT })).text, "第一段\n第二段");
});

test("模型不存在与鉴权失败都显式报错", async () => {
  const missing = createJudgeModelInvoker({
    source: sourceWith({ sessionModel: undefined, findModel: () => undefined }),
  });
  await assert.rejects(missing({ snapshot: SNAPSHOT }), /判定模型不可用|Judge model unavailable/);

  const configuredMissing = createJudgeModelInvoker({
    source: sourceWith({ configuredModel: "openai/unknown", findModel: () => undefined }),
  });
  await assert.rejects(configuredMissing({ snapshot: SNAPSHOT }), /openai\/unknown/);

  const authFailed = createJudgeModelInvoker({
    source: sourceWith({ resolveAuth: async () => ({ ok: false, error: "missing auth" }) }),
  });
  await assert.rejects(authFailed({ snapshot: SNAPSHOT }), /missing auth/);
});
