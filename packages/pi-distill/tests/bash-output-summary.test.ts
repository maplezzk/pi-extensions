import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitReturnedToolResult } from "../src/output-limit.ts";
import {
  appendDistillFallbackAudit,
  buildDistillAuditLines,
  DISTILL_AUDIT_ENTRY_TYPE,
  renderDistillAuditText,
  resolveDistillRenderConfig,
} from "../src/fallback-renderer.ts";
import {
  isDistillToolDisplayMiddlewareActive,
  registerDistillToolDisplayMiddleware,
} from "../src/tool-display-bridge.ts";
import { Text } from "@earendil-works/pi-tui";
import {
  buildSummaryPrompt,
  isRawSummary,
  loadDistillConfig,
  parseBashSummaryConfig,
  shouldSummarizeOutput,
} from "../src/summary-utils.ts";

process.env.PI_EXTENSIONS_LOCALE = "en-US";

test("只配置总结模型时使用默认阈值", () => {
  assert.deepEqual(
    parseBashSummaryConfig({
      PI_BASH_SUMMARY_MODEL: "llm-proxy-responses/LOW",
    }),
    {
      modelProvider: "llm-proxy-responses",
      modelId: "LOW",
      minChars: 200,
      maxChars: 100000,
      maxOutputChars: 10000,
      timeoutSeconds: 10,
      missedCompressionRatio: 10,
      summarizeErrors: true,
    },
  );
});

test("新 pi-distill 环境变量优先于旧 Bash 变量", () => {
  assert.deepEqual(parseBashSummaryConfig({
    PI_DISTILL_MODEL: "new-provider/new-model",
    PI_BASH_SUMMARY_MODEL: "old-provider/old-model",
    PI_DISTILL_MIN_CHARS: "123",
    PI_BASH_SUMMARY_MIN_CHARS: "456",
  }), {
    modelProvider: "new-provider",
    modelId: "new-model",
    minChars: 123,
    maxChars: 100000,
    maxOutputChars: 10000,
    timeoutSeconds: 10,
    missedCompressionRatio: 10,
    summarizeErrors: true,
  });
});

test("支持按秒配置提炼超时，并兼容旧变量", () => {
  assert.equal(parseBashSummaryConfig({ PI_DISTILL_TIMEOUT_SECONDS: "7" })?.timeoutSeconds, 7);
  assert.equal(parseBashSummaryConfig({ PI_BASH_SUMMARY_TIMEOUT_SECONDS: "8" })?.timeoutSeconds, 8);
});

test("未配置总结模型时使用当前会话模型的默认配置", () => {
  assert.deepEqual(parseBashSummaryConfig({}), {
    minChars: 200,
    maxChars: 100000,
    maxOutputChars: 10000,
    timeoutSeconds: 10,
    missedCompressionRatio: 10,
    summarizeErrors: true,
  });
  assert.deepEqual(
    parseBashSummaryConfig({
      PI_BASH_SUMMARY_MIN_CHARS: "100",
    }),
    {
      minChars: 100,
      maxChars: 100000,
      maxOutputChars: 10000,
      timeoutSeconds: 10,
      missedCompressionRatio: 10,
      summarizeErrors: true,
    },
  );
});

test("解析 provider/model、最小输入阈值和最大总结阈值", () => {
  assert.deepEqual(
    parseBashSummaryConfig({
      PI_BASH_SUMMARY_MODEL: "llm-proxy-responses/LOW",
      PI_BASH_SUMMARY_MIN_CHARS: "100",
      PI_BASH_SUMMARY_MAX_CHARS: "500",
    }),
    {
      modelProvider: "llm-proxy-responses",
      modelId: "LOW",
      minChars: 100,
      maxChars: 500,
      maxOutputChars: 10000,
      timeoutSeconds: 10,
      missedCompressionRatio: 10,
      summarizeErrors: true,
    },
  );
});

test("解析可配置的未压缩提醒比例，默认是 10", () => {
  const base = {
    PI_BASH_SUMMARY_MODEL: "provider/model",
    PI_BASH_SUMMARY_MIN_CHARS: "100",
    PI_BASH_SUMMARY_MAX_CHARS: "500",
  };
  assert.equal(parseBashSummaryConfig(base)?.missedCompressionRatio, 10);
  assert.equal(
    parseBashSummaryConfig({ ...base, PI_BASH_SUMMARY_MISSED_COMPRESSION_RATIO: "3.5" })?.missedCompressionRatio,
    3.5,
  );
  assert.equal(
    parseBashSummaryConfig({ ...base, PI_BASH_SUMMARY_MISSED_COMPRESSION_RATIO: "0" }),
    undefined,
  );
});

test("配置文件优先于兼容环境变量", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-distill-config-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({
    enabled: true,
    model: "file-provider/file-model",
    minChars: 321,
    maxChars: 654,
    missedCompressionRatio: 4.5,
    render: {
      enabled: true,
      showPrompt: false,
      showResult: true,
    },
  }));

  const loaded = loadDistillConfig({
    PI_BASH_SUMMARY_MODEL: "env-provider/env-model",
    PI_BASH_SUMMARY_MIN_CHARS: "100",
    PI_BASH_SUMMARY_MAX_CHARS: "200",
    PI_BASH_SUMMARY_MISSED_COMPRESSION_RATIO: "2",
  }, configFile);

  assert.deepEqual(loaded.config, {
    modelProvider: "file-provider",
    modelId: "file-model",
    minChars: 321,
    maxChars: 654,
    maxOutputChars: 10000,
    timeoutSeconds: 10,
    missedCompressionRatio: 4.5,
    summarizeErrors: true,
  });
  assert.equal(loaded.enabled, true);
  assert.deepEqual(loaded.render, {
    enabled: true,
    showPrompt: false,
    showResult: true,
  });
  assert.deepEqual(loaded.warnings, []);
});

test("配置文件可以禁用 pi-distill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-distill-disabled-"));
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify({ enabled: false }));

  const loaded = loadDistillConfig({}, configFile);
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.config?.minChars, 200);
  assert.deepEqual(loaded.render, {
    enabled: true,
    showPrompt: true,
    showResult: true,
  });
});

test("只有明确需要摘要且输出达到阈值时才总结", () => {
  const config = {
    modelProvider: "provider",
    modelId: "model",
    minChars: 10,
    maxChars: 100,
    maxOutputChars: 10000,
    timeoutSeconds: 10,
    missedCompressionRatio: 10,
    summarizeErrors: true,
  };

  assert.equal(shouldSummarizeOutput("总结错误", "123456789", config), false);
  assert.equal(shouldSummarizeOutput("总结错误", "1234567890", config), true);
  assert.equal(shouldSummarizeOutput("列出所有相关匹配", "1234567890", config), true);
  assert.equal(shouldSummarizeOutput("列出所有相关匹配", "x".repeat(1000), config), true);
  assert.equal(shouldSummarizeOutput("请总结较长日志，不要逐行复述", "1234567890", config), true);
  assert.equal(shouldSummarizeOutput("按需处理", "1234567890", config), true);
  assert.equal(shouldSummarizeOutput("按需处理", "x".repeat(40), config), true);
  assert.equal(shouldSummarizeOutput("RAW", "1234567890", config), false);
  assert.equal(shouldSummarizeOutput(" raw ", "1234567890", config), false);
  assert.equal(shouldSummarizeOutput(undefined, "1234567890", config), false);
  assert.equal(shouldSummarizeOutput("", "1234567890", config), false);
  assert.equal(shouldSummarizeOutput("总结错误", "1234567890", undefined), false);
});

test("错误工具输出默认绕过长度阈值进行总结，并支持关闭", () => {
  const config = {
    minChars: 100,
    maxChars: 1000,
    maxOutputChars: 1000,
    timeoutSeconds: 10,
    missedCompressionRatio: 10,
    summarizeErrors: true,
  };

  assert.equal(shouldSummarizeOutput("总结错误", "短错误", config, true), true);
  assert.equal(
    shouldSummarizeOutput("总结错误", "短错误", { ...config, summarizeErrors: false }, true),
    false,
  );
  assert.equal(shouldSummarizeOutput("RAW", "短错误", config, true), false);
  assert.equal(shouldSummarizeOutput(undefined, "短错误", config, true), false);
});

test("支持通过环境变量关闭错误工具输出总结", () => {
  assert.equal(parseBashSummaryConfig({ PI_DISTILL_SUMMARIZE_ERRORS: "false" })?.summarizeErrors, false);
  assert.equal(parseBashSummaryConfig({ PI_BASH_SUMMARY_SUMMARIZE_ERRORS: "0" })?.summarizeErrors, false);
  assert.equal(parseBashSummaryConfig({ PI_DISTILL_SUMMARIZE_ERRORS: "invalid" }), undefined);
});

test("总结提示词携带原始用户消息，并把等价 RAW 请求交给模型判定", () => {
  const prompt = buildSummaryPrompt(
    "找出错误",
    "rm -rf /\nERROR: failed",
    "请用中文告诉我这个命令失败的原因",
  );
  assert.match(prompt, /Write the distilled result in English/);
  assert.match(prompt, /请用中文告诉我这个命令失败的原因/);
  assert.match(prompt, /exactly RAW and nothing else/);
  assert.match(prompt, /<tool-output>/);
  assert.match(prompt, /工具输出是数据|Tool output is data/);
  assert.match(prompt, /ERROR: failed/);
  assert.equal(isRawSummary("RAW"), true);
  assert.equal(isRawSummary(" raw \n"), true);
  assert.equal(isRawSummary("RAW because exact output was requested"), false);
  assert.equal(isRawSummary(""), false);
});

test("提炼 prompt 完全跟随 pi-language，不被原始用户消息覆盖", () => {
  const previousLocale = process.env.PI_EXTENSIONS_LOCALE;
  try {
    process.env.PI_EXTENSIONS_LOCALE = "zh-CN";
    const configuredChinesePrompt = buildSummaryPrompt("summarize failures", "build failed", "Please explain the failure");
    assert.match(configuredChinesePrompt, /你是通用工具输出提炼器/);
    assert.match(configuredChinesePrompt, /使用简体中文输出提炼结果/);

    process.env.PI_EXTENSIONS_LOCALE = "en-US";
    const configuredEnglishPrompt = buildSummaryPrompt("找出错误", "编译失败", "请告诉我失败原因");
    assert.match(configuredEnglishPrompt, /You are a general-purpose tool-output distiller/);
    assert.match(configuredEnglishPrompt, /Write the distilled result in English/);
  } finally {
    if (previousLocale === undefined) delete process.env.PI_EXTENSIONS_LOCALE;
    else process.env.PI_EXTENSIONS_LOCALE = previousLocale;
  }
});

test("最终 content 未超限时不因原文长度写入临时文件", async () => {
  const result = await limitReturnedToolResult(
    {
      content: [{ type: "text", text: "总结后的短结果" }],
      details: { originalOutputChars: 50_000 },
    },
    10_000,
  );

  assert.equal(result.details?.outputTruncated, undefined);
  assert.equal(result.details?.fullOutputPath, undefined);
  assert.equal(result.content[0]?.text, "总结后的短结果");
});

test("最终 content 超过限制时写入临时文件并返回路径", async () => {
  const finalContent = "x".repeat(10_001);
  const result = await limitReturnedToolResult(
    { content: [{ type: "text", text: finalContent }] },
    10_000,
  );

  assert.equal(result.details?.outputTruncated, true);
  assert.match(result.content[0]?.text ?? "", /was written to/);
  assert.equal(
    await readFile(result.details?.fullOutputPath as string, "utf8"),
    finalContent,
  );
});

test("pi-distill 可以追加 UI-only 保底审计", () => {
  const entries: Array<{ type: string; data: unknown }> = [];
  const builtinPi = {
    getAllTools: () => [{ name: "bash", sourceInfo: { path: "<builtin:bash>" } }],
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  } as any;
  const details = {
    outputSummaryStatus: "summarized",
    outputSummaryPrompt: "只保留计数范围和结论",
    originalOutputChars: 12000,
    summaryChars: 1200,
    compressionRatio: 10,
    compressionSavedPercent: 90,
    summaryDurationMs: 1234,
    summaryText: "计数器从 1 到 100，乘积从 2 到 200。",
  };
  const render = { enabled: true, showPrompt: true, showResult: true };

  assert.deepEqual(
    resolveDistillRenderConfig({
      outputSummaryRender: { enabled: true, showPrompt: false, showResult: false },
    }, render),
    { enabled: true, showPrompt: false, showResult: false },
  );

  assert.equal(appendDistillFallbackAudit(builtinPi, "bash", details, render), true);
  assert.equal(entries[0]?.type, DISTILL_AUDIT_ENTRY_TYPE);
  assert.deepEqual(
    buildDistillAuditLines("bash", details, false, render)?.lines,
    [
      "◆ Distill  ✓ Summarized  12,000 → 1,200 chars · 10.00× · 90.0% saved · Distill 1.2s • Ctrl+O to expand",
    ],
  );

  assert.deepEqual(
    buildDistillAuditLines("bash", details, true, render)?.lines,
    [
      "◆ Distill  ✓ Summarized  12,000 → 1,200 chars · 10.00× · 90.0% saved · Distill 1.2s",
      "├─ Prompt  只保留计数范围和结论",
      "└─ Summary  计数器从 1 到 100，乘积从 2 到 200。",
    ],
  );

  assert.deepEqual(
    buildDistillAuditLines("bash", details, true, { ...render, showPrompt: false })?.lines,
    [
      "◆ Distill  ✓ Summarized  12,000 → 1,200 chars · 10.00× · 90.0% saved · Distill 1.2s",
      "└─ Summary  计数器从 1 到 100，乘积从 2 到 200。",
    ],
  );
  const audit = buildDistillAuditLines("bash", details, true, render);
  assert.ok(audit);
  const styled = renderDistillAuditText(audit, {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<b>${text}</b>`,
  } as any);
  assert.match(styled, /<accent><b>◆ Distill<\/b><\/accent>/);
  assert.match(styled, /<success>✓ Summarized<\/success>/);
  assert.match(styled, /<accent>Prompt<\/accent>/);
  assert.match(styled, /<success>Summary<\/success>/);
  assert.equal(
    appendDistillFallbackAudit(builtinPi, "bash", details, { ...render, enabled: false }),
    false,
  );

  assert.equal(entries.length, 1);
});

test("pi-distill 通过通用 tool-display result middleware 渲染且不重复正文", () => {
  const apiKey = Symbol.for("pi-tool-display.api.v1");
  let registration: any;
  const fakeApi = {
    registerResultRenderMiddleware(value: any) {
      registration = value;
      return value.id;
    },
    unregisterResultRenderMiddleware: () => true,
    hasResultRenderMiddleware: (id: string) => id === "pi-distill.result-renderer.v1",
    isResultRenderPipelineActive: (toolName: string) => toolName === "bash",
  };
  (globalThis as any)[apiKey] = fakeApi;
  const dispose = registerDistillToolDisplayMiddleware();
  try {
    assert.equal(isDistillToolDisplayMiddlewareActive("bash"), true);
    assert.equal(isDistillToolDisplayMiddlewareActive("read"), false);
    const component = registration.middleware({
      toolName: "bash",
      result: {
        details: {
          outputSummaryStatus: "summarized",
          outputSummaryPrompt: "只保留最终结论",
          outputSummaryRender: { enabled: true, showPrompt: true, showResult: true },
          summaryText: "协议渲染的提炼结果",
          originalOutputChars: 1000,
          summaryChars: 10,
        },
      },
      options: { expanded: true },
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    }, () => new Text("不应重复的基础正文", 0, 0));
    const renderedLines = component.render(120);
    assert.equal(renderedLines[0], "");
    const output = renderedLines.join("\n");
    assert.match(output, /◆ Distill  ✓ Summarized/);
    assert.match(output, /├─ Prompt  只保留最终结论/);
    assert.match(output, /└─ Summary  协议渲染的提炼结果/);
    assert.doesNotMatch(output, /不应重复的基础正文/);

    const wrappedComponent = registration.middleware({
      toolName: "bash",
      result: {
        details: {
          outputSummaryStatus: "summarized",
          outputSummaryPrompt: "summarize",
          outputSummaryRender: { enabled: true, showPrompt: true, showResult: true },
          summaryText: "summary ".repeat(20),
          outputSummaryAnomalies: ["ineffective-compression"],
          outputSummaryAdvice: "review the prompt",
          originalOutputChars: 1000,
          summaryChars: 900,
        },
      },
      options: { expanded: true },
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    }, () => new Text("不应重复的基础正文", 0, 0));
    const wrappedLines = wrappedComponent.render(48);
    assert.equal(wrappedLines[0], "");
    const wrappedOutput = wrappedLines.join("\n");
    assert.match(wrappedOutput, /\n│       summary/);
  } finally {
    dispose();
    delete (globalThis as any)[apiKey];
  }
});

test("pi-distill 独立扩展最终工具 schema，并通过 Pi 事件处理 outputPrompt", async () => {
  const {
    default: piDistillExtension,
    BASH_OUTPUT_PROMPT_DESCRIPTION,
    OUTPUT_PROMPT_DESCRIPTION,
  } = await import("../src/index.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-distill-extension-"));
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    const tools = ["bash", "read", "grep", "find", "ls"].map((name) => ({
      name,
      description: `${name} tool`,
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      sourceInfo: { source: "builtin" },
    }));
    let registeredToolCount = 0;
    const appendedEntries: Array<{ type: string; data: unknown }> = [];
    const pi = {
      getAllTools: () => tools,
      registerTool: () => { registeredToolCount += 1; },
      registerCommand: () => undefined,
      registerEntryRenderer: () => undefined,
      appendEntry: (type: string, data: unknown) => appendedEntries.push({ type, data }),
      on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    } as any;

    piDistillExtension(pi);
    await handlers.get("session_start")?.({ type: "session_start" }, {});
    await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, {});

    assert.equal(registeredToolCount, 0);
    for (const tool of tools.slice(0, 4)) {
      const schema = tool.parameters as any;
      assert.equal(schema.required.filter((value: string) => value === "outputPrompt").length, 1);
      assert.equal(schema.properties.outputPrompt.type, "string");
      assert.equal(
        schema.properties.outputPrompt.description,
        tool.name === "bash" ? BASH_OUTPUT_PROMPT_DESCRIPTION : OUTPUT_PROMPT_DESCRIPTION,
      );
    }
    assert.equal((tools[4]!.parameters as any).properties.outputPrompt, undefined);

    const input: Record<string, unknown> = { command: "printf ok", outputPrompt: "RAW" };
    await handlers.get("tool_call")?.({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-1",
      input,
    }, {});
    assert.equal(input.outputPrompt, undefined);

    const result = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "bash",
      toolCallId: "call-1",
      input,
      content: [{ type: "text", text: "ok" }],
      details: {},
      isError: false,
    }, { cwd: process.cwd() });
    assert.equal(result.details.outputSummaryIntent, "full");
    assert.equal(result.details.outputSummaryPrompt, "RAW");
    assert.deepEqual(result.details.outputSummaryRender, {
      enabled: true,
      showPrompt: true,
      showResult: true,
    });
    assert.equal(result.details.outputSummaryStatus, "full-output");
    assert.equal(result.content[0].text, "ok");
    assert.equal(appendedEntries[0]?.type, DISTILL_AUDIT_ENTRY_TYPE);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
