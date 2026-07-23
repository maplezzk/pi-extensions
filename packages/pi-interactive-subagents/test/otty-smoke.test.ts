/**
 * Otty backend smoke test.
 *
 * 直接调用 otty.ts 的导出函数，验证：
 *   1. isOttyRuntimeAvailable 检测 TERM_PROGRAM=otty + otty CLI
 *   2. isOttySendKeysEnabled 检测 ipc-allow-send-keys 配置
 *   3. readOttyPanes / getTabIdForPane / readOttyScreen 解析正确
 *   4. createOttySurface 创建新 pane 并通过 diffNewPane 推断 id
 *   5. closeOttySurface 清理（best-effort）+ state marker 同步
 *
 * 不在 pi pane 上跑（避免误触 TUI），全程在 herdr pane 上测试。
 *
 * 运行：
 *   cd pi-interactive-subagents && NODE_PATH=/opt/homebrew/lib/node_modules npx tsx test/otty-smoke.test.ts
 */

import { execSync } from "node:child_process";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isOttyRuntimeAvailable,
  isOttySendKeysEnabled,
  readOttyPanes,
  getTabIdForPane,
  readOttyScreen,
  createOttySurface,
  closeOttySurface,
  AGENT_OTTY_PANE_ID,
} from "pi-terminal-mux";

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function sleep(ms: number): void {
  try {
    execSync(`sleep ${(ms / 1000).toFixed(2)}`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

console.log("═══════════════════════════════════════");
console.log(" Otty backend smoke test");
console.log("═══════════════════════════════════════");

// ── 环境检测 ──
section("1. Environment detection");
const available = isOttyRuntimeAvailable();
ok(
  available,
  "isOttyRuntimeAvailable() returns true (TERM_PROGRAM=otty + otty CLI in PATH + app running)",
);
ok(
  typeof AGENT_OTTY_PANE_ID === "string" || AGENT_OTTY_PANE_ID === null,
  `AGENT_OTTY_PANE_ID captured at module load: ${AGENT_OTTY_PANE_ID ?? "null"}`,
);

if (!available) {
  console.log("\n⚠️  Otty not available — skipping remaining tests");
  console.log("   Run this inside Otty terminal: `otty` should be in PATH and TERM_PROGRAM=otty");
  process.exit(failed > 0 ? 1 : 0);
}

// ── send-keys 开关检测 ──
section("2. send-keys enablement");
const sendKeys = isOttySendKeysEnabled();
ok(typeof sendKeys === "boolean", `isOttySendKeysEnabled() returned ${sendKeys}`);
if (!sendKeys) {
  console.log("  ℹ️  send-keys disabled — 测试 send-command/send-escape 时会 noop");
  console.log("     在 ~/.config/otty/config.toml 中设置 ipc-allow-send-keys = true");
}

// ── panes 读取 ──
section("3. readOttyPanes");
const panes = readOttyPanes();
ok(panes.length > 0, `panes.length = ${panes.length} (>0)`);
ok(
  panes.some((p) => typeof p.id === "string" && p.id.startsWith("p_")),
  "at least one pane id starts with 'p_' (otty format)",
);
ok(
  typeof panes[0]?.tab_id === "string",
  `first pane has tab_id (${panes[0]?.tab_id ?? "?"})`,
);
const activeCount = panes.filter((p) => p.active).length;
ok(activeCount >= 1, `${activeCount} pane(s) marked active`);

// ── tab id 解析 ──
section("4. getTabIdForPane");
const samplePane = panes[0]!;
const tabId = getTabIdForPane(samplePane.id);
ok(
  tabId === samplePane.tab_id,
  `getTabIdForPane(${samplePane.id}) -> ${tabId ?? "null"} (expected ${samplePane.tab_id})`,
);

// ── readOttyScreen ──
section("5. readOttyScreen");
const screen = readOttyScreen(samplePane.id, 20);
ok(typeof screen === "string", `readOttyScreen returned ${screen.length} chars`);

// ── createSurface + state marker ──
section("6. createOttySurface");
const stateFile = join(
  tmpdir(),
  `otty-subagent-pane-${(AGENT_OTTY_PANE_ID ?? "default").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
);
try {
  rmSync(stateFile);
} catch {
  /* ignore */
}

const beforePanes = readOttyPanes();
const newPaneId = createOttySurface("smoke-test-1");
const afterPanes = readOttyPanes();

ok(typeof newPaneId === "string" && newPaneId.length > 0, `createOttySurface returned "${newPaneId}"`);
if (newPaneId) {
  ok(newPaneId.startsWith("p_"), `new pane id has otty format: ${newPaneId}`);
  ok(
    !beforePanes.some((p) => p.id === newPaneId),
    "new pane was not in pane list before createSurface",
  );
  ok(
    afterPanes.some((p) => p.id === newPaneId),
    "new pane appears in pane list after createSurface",
  );

  // 验证 state marker
  ok(existsSync(stateFile), `state marker written: ${stateFile}`);

  // 验证 readScreen 在新 pane 上能用
  const newScreen = readOttyScreen(newPaneId, 5);
  ok(typeof newScreen === "string", `readOttyScreen on new pane works (${newScreen.length} chars)`);

  // ── closeSurface 清理 ──
  section("7. closeOttySurface");
  closeOttySurface(newPaneId);
  sleep(300);
  const finalPanes = readOttyPanes();
  // Otty 1.0.4 已知问题：`otty pane close` 命令返回成功但不实际删除 pane。
  // 后端能做的只是清理 state marker、避免脏数据。验证 cleanup 逻辑正确即可。
  let stateAfter: { panes?: string[] } | null = null;
  try {
    stateAfter = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    stateAfter = null;
  }
  ok(
    stateAfter === null || !stateAfter.panes?.includes(newPaneId),
    "state marker cleaned up (pane removed from state.panes)",
  );
  // pane 实际是否被关掉由 Otty CLI 决定，不作为硬性断言。
  const paneStillThere = finalPanes.some((p) => p.id === newPaneId);
  if (paneStillThere) {
    console.log(
      `  ℹ️  pane ${newPaneId} still in pane list (Otty 1.0.4 pane close limitation, state marker still cleaned)`,
    );
  } else {
    ok(true, `pane ${newPaneId} no longer in pane list`);
  }
}

// ── 二次 createSurface 验证广度优先 ──
section("8. createSurface #2 (breadth-first)");
const secondId = createOttySurface("smoke-test-2");
if (secondId && newPaneId) {
  ok(secondId !== newPaneId, `second surface id differs from first (${secondId} vs ${newPaneId})`);
  closeOttySurface(secondId);
  sleep(300);
}

console.log("\n═══════════════════════════════════════");
console.log(`  通过: ${passed}  |  失败: ${failed}`);
console.log("═══════════════════════════════════════");

process.exit(failed > 0 ? 1 : 0);