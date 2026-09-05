import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveJavaSkill } from "../src/config-utils.ts";

const DEFAULT = "java-build";

test("配置文件优先于环境变量", () => {
  assert.equal(resolveJavaSkill("idea", "java-build", DEFAULT), "idea");
});

test("无配置文件时采用环境变量", () => {
  assert.equal(resolveJavaSkill(null, "intellij", DEFAULT), "intellij");
});

test("配置文件与环境变量都缺失时回退默认值", () => {
  assert.equal(resolveJavaSkill(null, null, DEFAULT), DEFAULT);
  assert.equal(resolveJavaSkill(undefined, undefined, DEFAULT), DEFAULT);
});

test("空字符串视为未设置", () => {
  assert.equal(resolveJavaSkill("", "gradle", DEFAULT), "gradle");
  assert.equal(resolveJavaSkill("", "", DEFAULT), DEFAULT);
});
