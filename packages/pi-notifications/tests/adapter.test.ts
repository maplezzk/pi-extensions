import assert from "node:assert/strict";
import test from "node:test";
import {
  createArgvNotificationAdapter,
  renderNotificationArgs,
  type NotificationFailure,
} from "../src/adapter.ts";

test("renders notification placeholders without changing unrelated argv values", () => {
  assert.deepEqual(
    renderNotificationArgs(
      ["--title", "{title}", "--message={message}", "literal", "{subtitle}/{title}"],
      { title: "Pi", subtitle: "Input", message: "Use \"edit\"" },
    ),
    ["--title", "Pi", "--message=Use \"edit\"", "literal", "Input/Pi"],
  );
});

test("argv adapter checks availability once and passes arguments without a shell", async () => {
  const checks: string[] = [];
  const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
  const adapter = createArgvNotificationAdapter(
    { command: "notify-tool", args: ["--title", "{title}", "--message", "{message}"] },
    1234,
    {
      isCommandAvailable(command) {
        checks.push(command);
        return true;
      },
      async run(command, args, timeoutMs) {
        calls.push({ command, args, timeoutMs });
      },
    },
  );

  await adapter.send({ title: "Pi", subtitle: "Done", message: "a; rm -rf /" });
  await adapter.send({ title: "Pi 2", subtitle: "Done", message: "second" });

  assert.deepEqual(checks, ["notify-tool"]);
  assert.deepEqual(calls, [
    {
      command: "notify-tool",
      args: ["--title", "Pi", "--message", "a; rm -rf /"],
      timeoutMs: 1234,
    },
    {
      command: "notify-tool",
      args: ["--title", "Pi 2", "--message", "second"],
      timeoutMs: 1234,
    },
  ]);
});

test("missing command is reported once and disables later sends", async () => {
  let checks = 0;
  let runs = 0;
  const adapter = createArgvNotificationAdapter(
    { command: "missing-notify-tool", args: [] },
    100,
    {
      isCommandAvailable() {
        checks++;
        return false;
      },
      async run() {
        runs++;
      },
    },
  );

  await assert.rejects(
    () => adapter.send({ title: "Pi", subtitle: "Done", message: "first" }),
    (error: NotificationFailure) => {
      assert.equal(error.kind, "missing");
      assert.equal(error.command, "missing-notify-tool");
      return true;
    },
  );
  await adapter.send({ title: "Pi", subtitle: "Done", message: "second" });

  assert.equal(checks, 1);
  assert.equal(runs, 0);
});

test("the first failed invocation is reported and later sends are skipped", async () => {
  let runs = 0;
  const adapter = createArgvNotificationAdapter(
    { command: "notify-tool", args: [] },
    100,
    {
      isCommandAvailable: () => true,
      async run() {
        runs++;
        throw new Error("exit code 7");
      },
    },
  );

  await assert.rejects(
    () => adapter.send({ title: "Pi", subtitle: "Done", message: "first" }),
    (error: NotificationFailure) => {
      assert.equal(error.kind, "failed");
      assert.equal(error.command, "notify-tool");
      assert.match(error.reason, /exit code 7/);
      return true;
    },
  );
  await adapter.send({ title: "Pi", subtitle: "Done", message: "second" });

  assert.equal(runs, 1);
});
