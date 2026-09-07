import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piNotifications from "../src/index.ts";

interface StubContext {
  cwd: string;
  hasUI: boolean;
  ui: { notify(message: string, level: string): void };
}

interface RegisteredHandler {
  event: string;
  handler: (event: any, context: StubContext) => unknown;
}

test("formats input and completion notifications through the lifecycle handlers", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-notifications-extension-"));
  const outputPath = join(agentDir, "notifications.jsonl");
  const captureScript = join(agentDir, "capture.cjs");
  const configDir = join(agentDir, "extensions", "pi-notifications");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    captureScript,
    "const fs = require('node:fs');\n" +
      "const [, , output, title, subtitle, message] = process.argv;\n" +
      "fs.appendFileSync(output, JSON.stringify({ title, subtitle, message }) + '\\n');\n",
    "utf8",
  );
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      adapter: {
        command: process.execPath,
        args: [captureScript, outputPath, "{title}", "{subtitle}", "{message}"],
      },
    }),
    "utf8",
  );

  try {
    const handlers: RegisteredHandler[] = [];
    const pi = {
      on(event: string, handler: RegisteredHandler["handler"]) {
        handlers.push({ event, handler });
      },
      // 配置命令仅需在真实宿主中注册，生命周期测试使用空实现。
      registerCommand() {},
    } as unknown as ExtensionAPI;
    piNotifications(pi);

    const context: StubContext = {
      cwd: "/tmp/example-project",
      hasUI: true,
      ui: { notify: () => undefined },
    };
    const handler = (event: string) => handlers.find((entry) => entry.event === event)?.handler;

    await handler("agent_start")?.({}, context);
    await handler("turn_end")?.({}, context);
    await handler("tool_call")?.({
      toolName: "ask_user_question",
      input: {
        questions: [
          { header: "Mode", question: "Choose one" },
          { header: "Other", question: "Another" },
        ],
      },
    }, context);
    await handler("agent_end")?.({
      messages: [{ role: "tool", isError: true }],
    }, context);

    // 两个通知进程独立完成，文件出现不代表两条记录都已写入。
    const notificationWaitTimeoutMs = 5_000;
    const notificationPollIntervalMs = 10;
    const expectedNotificationCount = 2;
    let lines: string[] = [];
    const deadline = Date.now() + notificationWaitTimeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(outputPath)) {
        lines = readFileSync(outputPath, "utf8").split("\n").slice(0, -1);
        if (lines.length >= expectedNotificationCount) break;
      }
      await new Promise((resolve) => setTimeout(resolve, notificationPollIntervalMs));
    }
    assert.equal(lines.length, expectedNotificationCount, "Timed out waiting for both notification records");
    const records = lines.map((line) => JSON.parse(line) as Record<string, string>);
    const inputRecord = records.find((record) => record.title?.endsWith("💬"));
    const completionRecord = records.find((record) => !record.title?.endsWith("💬"));
    assert.ok(inputRecord);
    assert.ok(completionRecord);
    assert.equal(inputRecord.title, "Pi · example-project 💬");
    assert.match(inputRecord.message ?? "", /Choose one/);
    assert.match(inputRecord.message ?? "", /2/);
    assert.match(completionRecord.subtitle ?? "", /Finished with errors|执行完成（有错误）/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
});
