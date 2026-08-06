import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getMuxBackend,
  muxSetupHint,
  getAgentPaneId,
  backendAgentPaneEnvVar,
  parseOrcaJson,
  extractOrcaCreateHandle,
  extractOrcaSplitHandle,
  extractOrcaReadTail,
  orcaSplitDirection,
  AGENT_ORCA_TERMINAL_HANDLE,
} from "../src/index.ts";

/** 保存并清理会干扰 orca 探测的环境变量 */
const ORCA_ENV_KEYS = [
  "TERM_PROGRAM",
  "ORCA_TERMINAL_HANDLE",
  "PI_TERMINAL_MUX",
  "PI_SUBAGENT_MUX",
  "PI_EXTENSIONS_LOCALE",
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ORCA_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ORCA_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ── JSON 信封解析（基于真实 orca CLI 输出的 fixture） ──

describe("parseOrcaJson", () => {
  test("容错：非 JSON / 空输出返回 null", () => {
    assert.equal(parseOrcaJson("not json"), null);
    assert.equal(parseOrcaJson(""), null);
    assert.equal(parseOrcaJson("   "), null);
  });
  test("解析合法信封", () => {
    const parsed = parseOrcaJson('{"id":"x","ok":true,"result":{}}');
    assert.equal(parsed?.ok, true);
  });
});

describe("extractOrcaCreateHandle", () => {
  // 真实 `orca terminal create --title pi-mux-probe --json` 输出（精简）
  const createFixture = {
    id: "535637ec-adb6-4831-867d-41998ba38868",
    ok: true,
    result: {
      terminal: {
        handle: "term_a408a611-f8a9-49f2-952f-c3e72907157b",
        tabId: "89de46de-d0e0-4da7-81f6-18deedaaaffb",
        title: "pi-mux-probe",
        surface: "visible",
      },
    },
  };

  test("从 create 响应提取 handle", () => {
    assert.equal(
      extractOrcaCreateHandle(createFixture),
      "term_a408a611-f8a9-49f2-952f-c3e72907157b",
    );
  });
  test("缺字段返回 null", () => {
    assert.equal(extractOrcaCreateHandle(null), null);
    assert.equal(extractOrcaCreateHandle({ ok: true }), null);
    assert.equal(extractOrcaCreateHandle({ ok: true, result: { terminal: {} } }), null);
    assert.equal(extractOrcaCreateHandle({ ok: false, result: { terminal: { handle: "term_x" } } }) , null);
  });
});

describe("extractOrcaSplitHandle", () => {
  // 真实 `orca terminal split --direction horizontal --json` 输出（精简）
  const splitFixture = {
    id: "62a002e2-c6b4-40d4-843b-5bbaa10cf855",
    ok: true,
    result: {
      split: {
        handle: "term_b4e28da4-c478-4870-8099-8c1e11e37c24",
        tabId: "89de46de-d0e0-4da7-81f6-18deedaaaffb",
        paneRuntimeId: 1,
      },
    },
  };

  test("从 split 响应提取新 pane handle", () => {
    assert.equal(
      extractOrcaSplitHandle(splitFixture),
      "term_b4e28da4-c478-4870-8099-8c1e11e37c24",
    );
  });
  test("缺字段返回 null", () => {
    assert.equal(extractOrcaSplitHandle(null), null);
    assert.equal(extractOrcaSplitHandle({ ok: true, result: {} }), null);
  });
});

describe("extractOrcaReadTail", () => {
  // 真实 `orca terminal read --limit 10 --json` 输出（精简）
  const readFixture = {
    ok: true,
    result: {
      terminal: {
        handle: "term_a408a611-f8a9-49f2-952f-c3e72907157b",
        status: "running",
        tail: ["probe-ok", "", "❯"],
        truncated: false,
        nextCursor: "12",
      },
    },
  };

  test("从 read 响应提取 tail 行", () => {
    assert.deepEqual(extractOrcaReadTail(readFixture), ["probe-ok", "", "❯"]);
  });
  test("缺字段返回空数组", () => {
    assert.deepEqual(extractOrcaReadTail(null), []);
    assert.deepEqual(extractOrcaReadTail({ ok: true, result: { terminal: {} } }), []);
  });
  test("tail 中非字符串项被过滤", () => {
    const payload = { ok: true, result: { terminal: { tail: ["a", 1, null, "b"] } } };
    assert.deepEqual(extractOrcaReadTail(payload), ["a", "b"]);
  });
});

describe("orcaSplitDirection", () => {
  // 实测（Orca 1.4.174）：horizontal = 上下堆叠，vertical = 左右并排
  test("左右 → vertical，上下 → horizontal", () => {
    assert.equal(orcaSplitDirection("left"), "vertical");
    assert.equal(orcaSplitDirection("right"), "vertical");
    assert.equal(orcaSplitDirection("up"), "horizontal");
    assert.equal(orcaSplitDirection("down"), "horizontal");
  });
});

// ── 探测与偏好（不依赖真实 orca runtime） ──

describe("orca 后端偏好", () => {
  test("PI_TERMINAL_MUX=orca 但不在 Orca 内时返回 null", () => {
    process.env.PI_TERMINAL_MUX = "orca";
    assert.equal(getMuxBackend(), null);
  });
  test("PI_SUBAGENT_MUX=orca 兼容别名不抛错", () => {
    process.env.PI_SUBAGENT_MUX = "orca";
    assert.equal(getMuxBackend(), null);
  });
});

describe("orca setupHint i18n", () => {
  test("中文提示", () => {
    process.env.PI_EXTENSIONS_LOCALE = "zh-CN";
    process.env.PI_TERMINAL_MUX = "orca";
    assert.match(muxSetupHint(), /请在 Orca 中运行 pi/);
  });
  test("英文提示", () => {
    process.env.PI_EXTENSIONS_LOCALE = "en-US";
    process.env.PI_TERMINAL_MUX = "orca";
    assert.match(muxSetupHint(), /Run pi inside Orca/);
  });
  test("通用提示包含 Orca", () => {
    process.env.PI_EXTENSIONS_LOCALE = "en-US";
    assert.match(muxSetupHint(), /Orca/);
  });
});

describe("orca agent pane 标识", () => {
  test("backendAgentPaneEnvVar 返回 ORCA_TERMINAL_HANDLE", () => {
    assert.equal(backendAgentPaneEnvVar("orca"), "ORCA_TERMINAL_HANDLE");
  });
  test("getAgentPaneId 与模块加载时捕获的常量一致", () => {
    // AGENT_ORCA_TERMINAL_HANDLE 在模块加载时冻结，测试只能断言两者一致
    assert.equal(getAgentPaneId("orca"), AGENT_ORCA_TERMINAL_HANDLE ?? null);
  });
});
