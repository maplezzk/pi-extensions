import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildModelChoices,
  formatModelValue,
  modelFromChoice,
  modelReference,
} from "../src/model-choice.ts";

/** 测试用「复用当前会话模型」文案。 */
const REUSE = "复用当前会话模型";

test("选择列表第一项是复用当前会话模型，其余是 provider/modelId", () => {
  const choices = buildModelChoices(
    [
      { provider: "llm-proxy-responses", id: "LOW" },
      { provider: "llm-proxy-responses", id: "HIGH" },
    ],
    REUSE,
  );

  assert.deepEqual(choices, [
    { label: REUSE, value: "" },
    { label: "llm-proxy-responses/LOW", value: "llm-proxy-responses/LOW" },
    { label: "llm-proxy-responses/HIGH", value: "llm-proxy-responses/HIGH" },
  ]);
});

test("重复注册的同一个模型只出现一次", () => {
  const choices = buildModelChoices(
    [
      { provider: "p", id: "m" },
      { provider: "p", id: "m" },
    ],
    REUSE,
  );

  assert.equal(choices.length, 2);
});

test("选到复用项写空值，选到模型写 provider/modelId", () => {
  const choices = buildModelChoices([{ provider: "p", id: "m" }], REUSE);

  assert.equal(modelFromChoice(REUSE, choices), "");
  assert.equal(modelFromChoice("p/m", choices), "p/m");
});

test("选到未知项（列表已变化）按复用当前会话模型处理，不写入非法模型", () => {
  const choices = buildModelChoices([{ provider: "p", id: "m" }], REUSE);

  assert.equal(modelFromChoice("gone/model", choices), "");
});

test("展示文本：空值显示为复用当前会话模型", () => {
  assert.equal(formatModelValue("", REUSE), REUSE);
  assert.equal(formatModelValue("p/m", REUSE), "p/m");
});

test("模型标识拼成 provider/modelId", () => {
  assert.equal(modelReference({ provider: "llm-proxy", id: "LOW" }), "llm-proxy/LOW");
});
