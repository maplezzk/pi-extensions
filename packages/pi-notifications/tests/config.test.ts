import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_NOTIFICATION_CONFIG,
  loadConfigWithDiagnostics,
} from "../src/config.ts";

function withAgentDir(run: (agentDir: string) => void): void {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-notifications-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    run(agentDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("uses defaults when the optional configuration file is absent", () => {
  withAgentDir(() => {
    const loaded = loadConfigWithDiagnostics();
    assert.deepEqual(loaded.config, DEFAULT_NOTIFICATION_CONFIG);
    assert.equal(loaded.diagnostic, undefined);
  });
});

test("loads the configured argv adapter and timeout", () => {
  withAgentDir((agentDir) => {
    const directory = join(agentDir, "extensions", "pi-notifications");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "config.json"),
      JSON.stringify({
        enabled: false,
        adapter: { command: "notify-send", args: ["{title}", "{message}"] },
        timeoutMs: 5000,
      }),
      "utf8",
    );

    const loaded = loadConfigWithDiagnostics();
    assert.deepEqual(loaded.config, {
      enabled: false,
      adapter: { command: "notify-send", args: ["{title}", "{message}"] },
      timeoutMs: 5000,
    });
    assert.equal(loaded.diagnostic, undefined);
  });
});

test("reports malformed configuration and returns defaults", () => {
  withAgentDir((agentDir) => {
    const directory = join(agentDir, "extensions", "pi-notifications");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "config.json"), "{\"timeoutMs\":\"slow\"}", "utf8");

    const loaded = loadConfigWithDiagnostics();
    assert.deepEqual(loaded.config, DEFAULT_NOTIFICATION_CONFIG);
    assert.ok(loaded.diagnostic);
    assert.match(loaded.diagnostic.reason, /timeoutMs/);
    assert.match(loaded.diagnostic.path, /pi-notifications[\\/]config\.json$/);
  });
});
