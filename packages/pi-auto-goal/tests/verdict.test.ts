import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildJudgeSystemPrompt,
  buildJudgeUserPrompt,
  createStopVerdictRequester,
  parseJudgeVerdict,
  type JudgeInvoker,
  type JudgeRequest,
} from "../src/verdict.ts";
import type { TurnSnapshot } from "../src/session-context.ts";

/** 固定的判定输入快照。 */
const SNAPSHOT: TurnSnapshot = {
  userRequest: "改好 a.ts 并跑测试",
  finalOutput: "已经改好 a.ts。",
  toolTrace: ["- read {\"path\":\"a.ts\"}"],
};

/** 返回固定响应并记录请求的判定调用替身。 */
function recordingInvoker(options: {
  text: string;
  stopReason?: string;
  errorMessage?: string;
  partTypes?: string[];
}): {
  invoke: JudgeInvoker;
  requests: JudgeRequest[];
} {
  const requests: JudgeRequest[] = [];
  const invoke: JudgeInvoker = async (request) => {
    requests.push(request);
    return {
      text: options.text,
      stopReason: options.stopReason ?? "stop",
      errorMessage: options.errorMessage,
      partTypes: options.partTypes ?? ["text:0"],
    };
  };
  return { invoke, requests };
}

test("parseJudgeVerdict 解析纯 JSON、代码块与带说明文字的响应", () => {
  assert.deepEqual(parseJudgeVerdict('{"decision":"continue","confidence":0.8,"reason":"缺测试"}'), {
    decision: "continue",
    confidence: 0.8,
    reason: "缺测试",
  });
  assert.deepEqual(parseJudgeVerdict('```json\n{"decision":"stop","confidence":0.4,"reason":"完成"}\n```'), {
    decision: "stop",
    confidence: 0.4,
    reason: "完成",
  });
  assert.equal(parseJudgeVerdict('判断如下：{"decision":"continue","confidence":1,"reason":"x"} 结束')?.decision, "continue");
});

test("parseJudgeVerdict 规整置信度并对非法响应返回 undefined", () => {
  assert.equal(parseJudgeVerdict('{"decision":"continue","confidence":5}')?.confidence, 1);
  assert.equal(parseJudgeVerdict('{"decision":"continue","confidence":-2}')?.confidence, 0);
  assert.equal(parseJudgeVerdict('{"decision":"continue","confidence":"high"}')?.confidence, 0);
  assert.equal(parseJudgeVerdict('{"decision":"continue"}')?.reason, "");

  for (const raw of [
    "",
    "没有 JSON",
    "{不是 JSON}",
    '{"decision":"maybe","confidence":1}',
    '{"decision":1,"confidence":1}',
    '["continue"]',
  ]) {
    assert.equal(parseJudgeVerdict(raw), undefined);
  }
});

test("判定提示词包含固定规则与三段上下文边界", () => {
  const system = buildJudgeSystemPrompt();
  assert.match(system, /JSON/);
  assert.match(system, /continue/);
  assert.match(system, /stop/);

  const user = buildJudgeUserPrompt(SNAPSHOT);
  assert.match(user, /<user-request>\n改好 a\.ts 并跑测试\n<\/user-request>/);
  assert.match(user, /<agent-final-output>\n已经改好 a\.ts。\n<\/agent-final-output>/);
  assert.match(user, /<tool-trace>\n- read/);
});

test("判定提示词把「输出里在等后台任务」列为可以停止", () => {
  const system = buildJudgeSystemPrompt();
  // 后台任务跑完会自己唤醒会话，所以这类停止不该被判为提前停止。
  assert.match(system, /后台任务|background work/);
  // 判断依据是 agent 的最后输出，而不是工具调用轨迹。
  assert.match(system, /最后输出|final output/);
  assert.doesNotMatch(system, /工具轨迹里出现这类调用|tool trace contains such a call/);
  assert.match(system, /subagent/);
  assert.match(system, /workflow/);
  // 这条规则必须明确优先于「列了计划却没执行」等早停条目，否则模型会两边摇摆。
  assert.match(system, /优先|outranks/);
});

test("空输出与空工具轨迹使用占位文案", () => {
  const user = buildJudgeUserPrompt({ userRequest: "任务", finalOutput: "", toolTrace: [] });
  assert.match(user, /\(agent 没有任何文本输出\)|（agent 没有任何文本输出）/);
  assert.match(user, /\(本轮没有任何工具调用\)|（本轮没有任何工具调用）/);
});

test("输出被截断且没有文本时报成「预算不足」，并带上诊断信息", async () => {
  const truncated = createStopVerdictRequester(recordingInvoker({
    text: "   ",
    stopReason: "length",
    partTypes: ["thinking:400"],
  }).invoke);
  await assert.rejects(truncated({ snapshot: SNAPSHOT }), (error: Error) => {
    assert.match(error.message, /截断|truncated/);
    // 诊断信息必须说明「只有思考块、没有文本」，否则下次仍然只能看到「空响应」。
    assert.match(error.message, /stopReason=length|结束原因=length/);
    assert.match(error.message, /thinking:400/);
    return true;
  });
});

test("非截断的空响应也带上内容块诊断", async () => {
  const empty = createStopVerdictRequester(recordingInvoker({
    text: "",
    stopReason: "stop",
    partTypes: ["thinking:174"],
  }).invoke);
  await assert.rejects(empty({ snapshot: SNAPSHOT }), (error: Error) => {
    assert.match(error.message, /空响应|empty response/);
    assert.match(error.message, /thinking:174/);
    return true;
  });
});

test("判定流程把原始响应转换成结构化结论并透传中止信号", async () => {
  const { invoke, requests } = recordingInvoker({
    text: '{"decision":"continue","confidence":0.7,"reason":"还缺验证"}',
  });
  const controller = new AbortController();
  const verdict = await createStopVerdictRequester(invoke)({ snapshot: SNAPSHOT, signal: controller.signal });

  assert.deepEqual(verdict, { decision: "continue", confidence: 0.7, reason: "还缺验证" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal, controller.signal);
  assert.equal(requests[0].snapshot.userRequest, SNAPSHOT.userRequest);
});

test("判定流程对失败结束原因与无法解析的响应显式报错", async () => {
  const failed = createStopVerdictRequester(recordingInvoker({
    text: "",
    stopReason: "error",
    errorMessage: "provider down",
  }).invoke);
  await assert.rejects(failed({ snapshot: SNAPSHOT }), /provider down/);

  const aborted = createStopVerdictRequester(recordingInvoker({ text: "", stopReason: "aborted" }).invoke);
  await assert.rejects(aborted({ snapshot: SNAPSHOT }), /判定模型请求失败|Judge model request failed/);

  const unparsable = createStopVerdictRequester(recordingInvoker({ text: "我不会输出 JSON" }).invoke);
  await assert.rejects(unparsable({ snapshot: SNAPSHOT }), /无法解析|unparsable/);

  const empty = createStopVerdictRequester(recordingInvoker({ text: "   " }).invoke);
  await assert.rejects(empty({ snapshot: SNAPSHOT }), /空响应|empty response/);
});

test("底层调用抛出的错误原样传播，不做二次包装", async () => {
  const invoke: JudgeInvoker = async () => {
    throw new Error("network unreachable");
  };
  await assert.rejects(
    createStopVerdictRequester(invoke)({ snapshot: SNAPSHOT }),
    /network unreachable/,
  );
});
