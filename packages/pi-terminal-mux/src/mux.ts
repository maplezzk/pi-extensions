import { execSync, execFile, execFileSync, spawnSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, createWriteStream, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { WriteStream } from "node:fs";
import { i18n } from "./i18n.ts";

/**
 * 分屏调试日志写入文件，避免污染 TUI 终端。
 * 日志路径: /tmp/pi-muxy-split.log
 *
 * 注意：必须用 /tmp/，不能用 os.tmpdir()。herdr 的日志已经写到
 * /tmp/pi-herdr-split.log，用户排查问题时只看 /tmp/ 即可。
 * 之前用 tmpdir() 导致 macOS 上日志落到 /var/folders/.../T/，与
 * /tmp/ 分裂，用户 grep /tmp 找不到，调试时被坑过。
 */
const MUXY_SPLIT_LOG = "/tmp/pi-muxy-split.log";

export function muxLog(msg: string): void {
  try {
    appendFileSync(MUXY_SPLIT_LOG, `[${new Date().toISOString()}] ${msg}`);
  } catch {
    // 写日志失败不影响主流程
  }
}

const execFileAsync = promisify(execFile);

/**
 * Agent's own pane ID in Muxy, captured at module load time.
 * Unlike reading process.env.MUXY_PANE_ID dynamically (which may reflect
 * the user's currently focused pane after switching projects in Muxy),
 * this constant always points to the pane where the agent/pi was launched.
 */
export const AGENT_MUXY_PANE_ID = process.env.MUXY_PANE_ID;

export type MuxBackend = "cmux" | "muxy" | "tmux" | "zellij" | "wezterm" | "herdr" | "otty";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  // PI_TERMINAL_MUX 为通用包的首选变量；PI_SUBAGENT_MUX 保留向后兼容。
  const pref = (process.env.PI_TERMINAL_MUX ?? process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (
    pref === "cmux" ||
    pref === "muxy" ||
    pref === "tmux" ||
    pref === "zellij" ||
    pref === "wezterm" ||
    pref === "herdr" ||
    pref === "otty"
  )
    return pref;
  return null;
}

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isMuxyRuntimeAvailable(): boolean {
  return !!process.env.MUXY_SOCKET_PATH && hasCommand("muxy");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

function isWezTermRuntimeAvailable(): boolean {
  return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
}

import {
  isHerdrRuntimeAvailable,
  createHerdrSurface,
  splitHerdrPane,
  renameHerdrPane,
  renameHerdrAgent,
  renameHerdrTab,
  renameHerdrWorkspace,
  sendHerdrCommand,
  sendHerdrEscape,
  readHerdrScreen,
  closeHerdrSurface,
  AGENT_HERDR_PANE_ID,
} from "./herdr.ts";
import {
  isOttyRuntimeAvailable,
  createOttySurface,
  sendOttyCommand,
  sendOttyEscape,
  readOttyScreen,
  closeOttySurface,
  renameOttyTab,
  ottySetupHint,
  AGENT_OTTY_PANE_ID,
} from "./otty.ts";

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
  return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
}

export function isWezTermAvailable(): boolean {
  return isWezTermRuntimeAvailable();
}

export function isHerdrAvailable(): boolean {
  return isHerdrRuntimeAvailable();
}

export function isOttyAvailable(): boolean {
  return isOttyRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "muxy") return isMuxyRuntimeAvailable() ? "muxy" : null;
  if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
  if (pref === "wezterm") return isWezTermRuntimeAvailable() ? "wezterm" : null;
  if (pref === "herdr") return isHerdrRuntimeAvailable() ? "herdr" : null;
  if (pref === "otty") return isOttyRuntimeAvailable() ? "otty" : null;

  if (isMuxyRuntimeAvailable()) return "muxy";
  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isTmuxRuntimeAvailable()) return "tmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  if (isWezTermRuntimeAvailable()) return "wezterm";
  if (isHerdrRuntimeAvailable()) return "herdr";
  if (isOttyRuntimeAvailable()) return "otty";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref) {
    const hint = i18n.t(`setupHint.${pref}`);
    // otty 在 send-keys 未启用时补充更具体的提示
    if (pref === "otty") {
      return ottySetupHint() || hint;
    }
    return hint;
  }
  return i18n.t("setupHint.generic");
}

// ── Headless mode (no terminal multiplexer available) ──

const HEADLESS_SURFACE_PREFIX = "headless:";

interface HeadlessProcess {
  child: ChildProcess;
  exitPromise: Promise<{ exitCode: number }>;
  resolveExit: ((value: { exitCode: number }) => void) | null;
  logStream: WriteStream;
  logFile: string;
}

const headlessProcesses = new Map<string, HeadlessProcess>();

export function createHeadlessSurface(name: string): string {
  const id = `${HEADLESS_SURFACE_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return id;
}

export function spawnHeadlessProcess(
  surface: string,
  name: string,
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
): { logFile: string } {
  const safeId = surface.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFile = join(tmpdir(), `pi-subagent-${safeId}.log`);
  const logStream = createWriteStream(logFile, { flags: "w" });

  const env = { ...process.env };
  if (options?.env) {
    Object.assign(env, options.env);
  }
  env.PI_SUBAGENT_HEADLESS = "1";

  const child = spawn("bash", ["-c", command], {
    cwd: options?.cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.stdout.resume();
  child.stderr.resume();

  let resolveExit: ((value: { exitCode: number }) => void) | null = null;
  const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
    resolveExit = resolve;
    child.on("exit", (code) => {
      logStream.end();
      resolve({ exitCode: code ?? 1 });
    });
    child.on("error", () => {
      logStream.end();
      resolve({ exitCode: 1 });
    });
  });

  headlessProcesses.set(surface, { child, exitPromise, resolveExit, logStream, logFile });

  return { logFile };
}

export function closeHeadlessSurface(surface: string): void {
  const proc = headlessProcesses.get(surface);
  if (!proc) return;
  try {
    proc.child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      proc.child.kill("SIGKILL");
    } catch {}
    headlessProcesses.delete(surface);
  }, 3000).unref();
}

export function sendHeadlessEscape(surface: string): void {
  const proc = headlessProcesses.get(surface);
  if (!proc) return;
  try {
    proc.child.kill("SIGINT");
  } catch {}
}

export function readHeadlessScreen(surface: string, lines = 50): string {
  const proc = headlessProcesses.get(surface);
  if (!proc) return "";
  try {
    const content = readFileSync(proc.logFile, "utf8");
    const split = content.split("\n");
    return split.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export async function readHeadlessScreenAsync(surface: string, lines = 50): Promise<string> {
  return readHeadlessScreen(surface, lines);
}

export function isHeadlessSurface(surface: string): boolean {
  return surface.startsWith(HEADLESS_SURFACE_PREFIX) || headlessProcesses.has(surface);
}

export function isHeadlessMode(): boolean {
  return !isMuxAvailable();
}

export function cleanupHeadlessProcesses(): void {
  for (const [surface, proc] of headlessProcesses) {
    try {
      proc.child.kill("SIGTERM");
    } catch {}
  }
  headlessProcesses.clear();
}

export function getHeadlessProcessExit(surface: string): Promise<{ exitCode: number }> | null {
  const proc = headlessProcesses.get(surface);
  return proc?.exitPromise ?? null;
}

export function drainHeadlessProcess(surface: string): void {
  headlessProcesses.delete(surface);
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`${i18n.t("setupHint.none")} ${muxSetupHint()}`);
  }
  return backend;
}

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

function zellijPaneId(surface: string): string {
  return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (surface) {
    env.ZELLIJ_PANE_ID = zellijPaneId(surface);
  }
  return env;
}

/**
 * Pane-scoped zellij actions that must target a specific pane via --pane-id
 * (the ZELLIJ_PANE_ID env var is ignored by most of these).
 * See https://github.com/HazAT/pi-interactive-subagents/issues/19
 */
const ZELLIJ_PANE_SCOPED_ACTIONS = new Set([
  "close-pane",
  "dump-screen",
  "rename-pane",
  "move-pane",
  "write",
  "write-chars",
  "send-keys",
]);

function zellijActionArgs(args: string[], surface?: string): string[] {
  if (!surface) return ["action", ...args];
  const action = args[0];
  if (!ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return ["action", ...args];
  // Don't double-add if caller already specified it.
  if (args.includes("--pane-id") || args.includes("-p")) return ["action", ...args];
  return ["action", action, "--pane-id", zellijPaneId(surface), ...args.slice(1)];
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

async function zellijActionAsync(args: string[], surface?: string): Promise<string> {
  const { stdout } = await execFileAsync("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
  return stdout;
}

/** Tracked subagent pane for cmux — reused across subagent launches. */
let cmuxSubagentPane: string | null = null;

/**
 * 最近一次 createSurface / createSurfaceSplit 的来源 pane。
 * 用于在 pi TUI 中展示「新分屏来自哪个 pane」。
 * 每次调用 createSurface 时更新，调用方读取后可重置。
 */
let lastSplitSource: string | null = null;

export function getLastSplitSource(): string | null {
  return lastSplitSource;
}

export function clearLastSplitSource(): void {
  lastSplitSource = null;
}

// Mirrors Zellij 0.44.x tab minimums, used to predict which pane Zellij itself
// will choose for a directionless split.
const ZELLIJ_MIN_TERMINAL_WIDTH = 5;
const ZELLIJ_MIN_TERMINAL_HEIGHT = 5;
const ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO = 4;

// Pi subagents need more usable space than Zellij's internal minimum. These can
// be tuned per session without another code change.
const DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS = 50;
const DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS = 10;

export interface ZellijPaneSnapshot {
  id: number;
  is_plugin?: boolean;
  is_floating?: boolean;
  is_selectable?: boolean;
  exited?: boolean;
  pane_rows?: number;
  pane_columns?: number;
  tab_id?: number;
  is_focused?: boolean;
}

export type ZellijSplitDirection = "down" | "right";

export type ZellijPlacementPlan =
  | {
      mode: "split";
      anchorPaneId: number;
      targetPaneId: number;
      tabId: number;
      splitDirection: ZellijSplitDirection;
    }
  | { mode: "stack"; anchorPaneId: number; targetPaneId: number; tabId: number };

function paneArea(pane: ZellijPaneSnapshot): number {
  return (pane.pane_rows ?? 0) * (pane.pane_columns ?? 0);
}

function isUsableZellijTiledPane(pane: ZellijPaneSnapshot): boolean {
  return (
    !pane.is_plugin &&
    !pane.is_floating &&
    pane.is_selectable !== false &&
    !pane.exited &&
    typeof pane.pane_rows === "number" &&
    typeof pane.pane_columns === "number"
  );
}

export function predictZellijSplitDirection(pane: ZellijPaneSnapshot): ZellijSplitDirection | null {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  if (columns < ZELLIJ_MIN_TERMINAL_WIDTH || rows < ZELLIJ_MIN_TERMINAL_HEIGHT) return null;

  if (
    rows * ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO > columns &&
    rows > ZELLIJ_MIN_TERMINAL_HEIGHT * 2
  ) {
    return "down";
  }

  if (columns > ZELLIJ_MIN_TERMINAL_WIDTH * 2) {
    return "right";
  }

  return null;
}

export function canSplitZellijPane(
  pane: ZellijPaneSnapshot,
  minColumns = ZELLIJ_MIN_TERMINAL_WIDTH,
  minRows = ZELLIJ_MIN_TERMINAL_HEIGHT,
): boolean {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  const direction = predictZellijSplitDirection(pane);
  if (!direction) return false;

  if (direction === "down") {
    return columns >= minColumns && Math.floor(rows / 2) >= minRows;
  }

  return rows >= minRows && Math.floor(columns / 2) >= minColumns;
}

function zellijTabPanesForParent(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
): { parentPane: ZellijPaneSnapshot; tabPanes: ZellijPaneSnapshot[] } | null {
  const parentPane = panes.find((pane) => !pane.is_plugin && pane.id === parentPaneId);
  if (!parentPane || typeof parentPane.tab_id !== "number") return null;

  const tabPanes = panes
    .filter((pane) => pane.tab_id === parentPane.tab_id)
    .filter(isUsableZellijTiledPane);

  return { parentPane, tabPanes };
}

export function selectZellijStackPlacement(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
): ZellijPlacementPlan | null {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;

  const stackTarget = tabInfo.tabPanes
    .filter((pane) => pane.id !== parentPaneId)
    .sort((a, b) => paneArea(b) - paneArea(a))[0];
  if (!stackTarget) return null;

  return {
    mode: "stack",
    anchorPaneId: stackTarget.id,
    targetPaneId: stackTarget.id,
    tabId: tabInfo.parentPane.tab_id!,
  };
}

export function selectZellijPlacement(
  panes: ZellijPaneSnapshot[],
  parentPaneId: number,
  minColumns = DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
  minRows = DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
): ZellijPlacementPlan | null {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;

  const zellijSplitCandidates = tabInfo.tabPanes
    .map((pane) => ({ pane, splitDirection: predictZellijSplitDirection(pane) }))
    .filter(
      (candidate): candidate is { pane: ZellijPaneSnapshot; splitDirection: ZellijSplitDirection } =>
        candidate.splitDirection !== null &&
        canSplitZellijPane(candidate.pane, ZELLIJ_MIN_TERMINAL_WIDTH, ZELLIJ_MIN_TERMINAL_HEIGHT),
    );

  const safeSplitCandidates = zellijSplitCandidates.filter((candidate) =>
    canSplitZellijPane(candidate.pane, minColumns, minRows),
  );

  // Split creation is tab-scoped, so Zellij chooses the concrete split pane.
  // Only split when every pane Zellij might split would remain usable.
  if (
    zellijSplitCandidates.length > 0 &&
    safeSplitCandidates.length === zellijSplitCandidates.length
  ) {
    const splitTarget = safeSplitCandidates.sort((a, b) => paneArea(b.pane) - paneArea(a.pane))[0];
    return {
      mode: "split",
      anchorPaneId: splitTarget.pane.id,
      targetPaneId: splitTarget.pane.id,
      tabId: tabInfo.parentPane.tab_id!,
      splitDirection: splitTarget.splitDirection,
    };
  }

  return selectZellijStackPlacement(panes, parentPaneId);
}

function parseZellijPaneSurface(rawId: string, context: string): string {
  const idMatch = rawId.match(/(\d+)/);
  if (!idMatch) {
    throw new Error(`Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`);
  }
  return `pane:${idMatch[1]}`;
}

function readZellijPanes(): ZellijPaneSnapshot[] {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = zellijActionSync(["list-panes", "--json", "--geometry", "--state", "--tab"]);
      if (!output.trim()) {
        throw new Error("Unexpected zellij list-panes output: empty");
      }
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) {
        throw new Error("Unexpected zellij list-panes output: not an array");
      }
      return parsed as ZellijPaneSnapshot[];
    } catch (error) {
      lastError = error;
      if (attempt < 2) sleepSync(50);
    }
  }
  throw lastError;
}

function createZellijTiledPane(name: string, tabId: number): string {
  const args = ["new-pane", "--tab-id", String(tabId), "--name", name, "--cwd", process.cwd()];
  return parseZellijPaneSurface(zellijActionSync(args).trim(), "new-pane");
}

function createZellijStackedPane(name: string, anchorSurface: string): string {
  const args = [
    "new-pane",
    "--stacked",
    "--near-current-pane",
    "--name",
    name,
    "--cwd",
    process.cwd(),
  ];
  return parseZellijPaneSurface(zellijActionSync(args, anchorSurface).trim(), "new-pane --stacked");
}

function createZellijTab(name: string): string {
  const tabIdRaw = zellijActionSync(["new-tab", "--name", name, "--cwd", process.cwd()]).trim();
  const tabId = Number(tabIdRaw);
  if (!Number.isInteger(tabId)) {
    throw new Error(`Unexpected zellij tab id from new-tab: ${tabIdRaw || "(empty)"}`);
  }

  try {
    const panes = readZellijPanes();
    const pane = panes.find(
      (candidate) =>
        candidate.tab_id === tabId &&
        isUsableZellijTiledPane(candidate) &&
        typeof candidate.id === "number",
    );
    if (!pane) {
      throw new Error(`Could not find initial pane for zellij tab ${tabId}`);
    }

    const surface = `pane:${pane.id}`;
    try {
      zellijActionSync(["rename-pane", name], surface);
    } catch {
      // Optional.
    }
    return surface;
  } catch (error) {
    try {
      zellijActionSync(["close-tab", "--tab-id", String(tabId)]);
    } catch {
      // Best effort cleanup for tabs created before post-creation inspection failed.
    }
    throw error;
  }
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function zellijSurfaceLockPath(): string {
  const session = (process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "default").replace(
    /[^A-Za-z0-9_.-]/g,
    "_",
  );
  return join(tmpdir(), `pi-zellij-surface-${session}.lock`);
}

function withZellijSurfaceLock<T>(callback: () => T): T {
  const lockPath = zellijSurfaceLockPath();
  const deadline = Date.now() + 10000;

  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30000) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}

      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for zellij surface lock: ${lockPath}`);
      }
      sleepSync(50);
    }
  }

  try {
    return callback();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function createZellijSurfaceUnlocked(name: string): string {
  const parentPaneIdRaw = process.env.ZELLIJ_PANE_ID;
  const parentPaneId = parentPaneIdRaw ? Number(parentPaneIdRaw) : NaN;
  const minColumns = envPositiveInteger(
    "PI_SUBAGENT_ZELLIJ_MIN_COLUMNS",
    DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
  );
  const minRows = envPositiveInteger(
    "PI_SUBAGENT_ZELLIJ_MIN_ROWS",
    DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
  );

  const plan = Number.isInteger(parentPaneId)
    ? selectZellijPlacement(readZellijPanes(), parentPaneId, minColumns, minRows)
    : null;

  if (plan?.mode === "split") {
    return createZellijTiledPane(name, plan.tabId);
  }

  if (plan?.mode === "stack") {
    return createZellijStackedPane(name, `pane:${plan.targetPaneId}`);
  }

  return createZellijTab(name);
}

function createZellijSurface(name: string): string {
  return withZellijSurfaceLock(() => createZellijSurfaceUnlocked(name));
}

type CmuxFocusSnapshot = {
  surfaceRef?: string;
  paneRef?: string;
};

type CmuxCreatedSurface = {
  surface: string;
  paneRef?: string;
};

type CmuxIdentifySnapshot = {
  focused: CmuxFocusSnapshot | null;
  caller: CmuxFocusSnapshot | null;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseCmuxFocusedSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const focused = (value as { focused?: unknown }).focused;
  if (!focused || typeof focused !== "object") return null;

  const record = focused as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch (error) {
    void error;
    return null;
  }
}

export function parseCmuxFocusedSnapshotFromJson(value: string): CmuxFocusSnapshot | null {
  return parseCmuxFocusedSnapshot(parseCmuxJson(value));
}

function parseCmuxCallerSnapshot(value: unknown): CmuxFocusSnapshot | null {
  if (!value || typeof value !== "object") return null;

  const caller = (value as { caller?: unknown }).caller;
  if (!caller || typeof caller !== "object") return null;

  const record = caller as { surface_ref?: unknown; pane_ref?: unknown };
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : undefined;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : undefined;

  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}

export function parseCmuxPaneRefForSurface(value: unknown, surface: string): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as { surface_ref?: unknown; pane_ref?: unknown; caller?: unknown };
  if (record.surface_ref === surface && nonEmptyString(record.pane_ref)) return record.pane_ref;

  const caller = record.caller;
  if (!caller || typeof caller !== "object") return null;

  const callerRecord = caller as { surface_ref?: unknown; pane_ref?: unknown };
  if (callerRecord.surface_ref === surface && nonEmptyString(callerRecord.pane_ref)) {
    return callerRecord.pane_ref;
  }

  return null;
}

export function parseCmuxPaneRefForSurfaceFromJson(value: string, surface: string): string | null {
  return parseCmuxPaneRefForSurface(parseCmuxJson(value), surface);
}

function readCmux(args: string[]): string | null {
  const result = spawnSync("cmux", args, { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout;
}

function parseCmuxIdentifySnapshot(value: string | null): CmuxIdentifySnapshot {
  const parsed = value ? parseCmuxJson(value) : null;
  return {
    focused: parseCmuxFocusedSnapshot(parsed),
    caller: parseCmuxCallerSnapshot(parsed),
  };
}

function captureCmuxIdentifySnapshot(): CmuxIdentifySnapshot {
  return parseCmuxIdentifySnapshot(readCmux(["identify", "--json"]));
}

function captureCmuxFocusSnapshot(): CmuxFocusSnapshot | null {
  return captureCmuxIdentifySnapshot().focused;
}

function readCmuxPaneRefForSurface(surface: string): string | null {
  const info = readCmux(["identify", "--surface", surface]);
  return info ? parseCmuxPaneRefForSurfaceFromJson(info, surface) : null;
}

function restoreCmuxFocusSnapshot(snapshot: CmuxFocusSnapshot | null): void {
  if (!snapshot) return;

  if (snapshot.paneRef) {
    spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], { encoding: "utf8" });
  }

  if (snapshot.surfaceRef) {
    spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], { encoding: "utf8" });
  }
}

function waitForCmuxFocusSettle(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

function cmuxFocusMatchesChild(
  currentFocus: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
): boolean {
  if (!currentFocus) return false;
  if (currentFocus.surfaceRef === child.surface) return true;
  return !!currentFocus.paneRef && currentFocus.paneRef === child.paneRef;
}

function cmuxFocusMatchesSurfaceRef(
  currentFocus: CmuxFocusSnapshot | null,
  surfaceRef: string | undefined,
): boolean {
  return !!surfaceRef && currentFocus?.surfaceRef === surfaceRef;
}

function cmuxFocusMatchesPaneRef(
  currentFocus: CmuxFocusSnapshot | null,
  paneRef: string | undefined,
): boolean {
  return !!paneRef && currentFocus?.paneRef === paneRef;
}

function restoreCmuxFocusIfLaunchSurfaceFocused(
  snapshot: CmuxFocusSnapshot | null,
  child: CmuxCreatedSurface,
  options?: { sourceSurfaceRef?: string; callerSnapshot?: CmuxFocusSnapshot | null },
): void {
  if (!snapshot) return;

  waitForCmuxFocusSettle();
  const currentFocus = captureCmuxFocusSnapshot();
  if (
    cmuxFocusMatchesChild(currentFocus, child) ||
    cmuxFocusMatchesSurfaceRef(currentFocus, options?.sourceSurfaceRef) ||
    cmuxFocusMatchesSurfaceRef(currentFocus, options?.callerSnapshot?.surfaceRef) ||
    // cmux can settle focus onto another active surface in the caller pane after creating a split/surface.
    cmuxFocusMatchesPaneRef(currentFocus, options?.callerSnapshot?.paneRef)
  ) {
    restoreCmuxFocusSnapshot(snapshot);
  }
}

function parseCmuxCreatedSurface(output: string, command: string): CmuxCreatedSurface {
  const surfaceMatch = output.match(/surface:\d+/);
  if (!surfaceMatch) {
    throw new Error(`Unexpected cmux ${command} output: ${output}`);
  }

  return {
    surface: surfaceMatch[0],
    paneRef: output.match(/pane:\d+/)?.[0],
  };
}

function renameCmuxSurface(surface: string, name: string): void {
  execFileSync("cmux", ["rename-tab", "--surface", surface, name], { encoding: "utf8" });
}

function renameMuxySurface(surface: string, name: string): void {
  try {
    execFileSync("muxy", ["rename-pane", "--pane", surface, name], { encoding: "utf8" });
  } catch {}
}

function createCmuxSplitSurface(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): CmuxCreatedSurface {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  let child: CmuxCreatedSurface | null = null;

  try {
    const args = ["new-split", direction];
    if (fromSurface) args.push("--surface", fromSurface);

    const output = execFileSync("cmux", args, { encoding: "utf8" }).trim();
    child = parseCmuxCreatedSurface(output, "new-split");
    child.paneRef ??= readCmuxPaneRefForSurface(child.surface) ?? undefined;
    renameCmuxSurface(child.surface, name);
    return child;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        sourceSurfaceRef: fromSurface,
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot);
    }
  }
}

/**
 * Create a new terminal surface for a subagent.
 *
 * For cmux: the first call creates a right-split pane; subsequent calls add
 * tabs to that same pane (avoiding ever-narrower splits).
 * For zellij: chooses a tab-aware tiled or stacked placement.
 * For tmux/wezterm: falls back to split behavior.
 *
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm).
 */
export function createSurface(name: string): string {
  // Fall back to headless mode when no terminal multiplexer is available
  if (!isMuxAvailable()) {
    return createHeadlessSurface(name);
  }

  const backend = getMuxBackend();

  if (backend === "cmux" && cmuxSubagentPane) {
    // Verify the pane still exists before adding a tab to it
    try {
      const tree = execSync(`cmux tree`, { encoding: "utf8" });
      if (tree.includes(cmuxSubagentPane)) {
        return createSurfaceInPane(name, cmuxSubagentPane);
      }
    } catch {}
    // Pane is gone — fall through to create a new split
    cmuxSubagentPane = null;
  }

  if (backend === "muxy") {
    const markerFile = `/tmp/muxy-subagent-pane-${AGENT_MUXY_PANE_ID || "default"}`;
    const lockFile = `${markerFile}.lock`;

    // ── 全局锁：所有分屏操作串行化，防止并发竞争 ──
    const acquired = (() => {
      for (let i = 0; i < 60; i++) {
        if (!existsSync(lockFile)) {
          try {
            writeFileSync(lockFile, `${process.pid}`, { flag: "wx" });
            return true;
          } catch {
            // 竞争失败，继续等待
          }
        }
        spawnSync("sleep", ["0.05"]);
      }
      return false;
    })();

    if (!acquired) return "";

    try {
      // ── 广度优先分屏 ──
      // 状态（JSON）：{ panes: string[], pos: number, base: number, dir: "right"|"down" }
      // panes: 所有 subagent pane ID 列表
      // pos:   本轮下一个要 split 的 pane 索引
      // base:  本轮开始时 pane 总数（本轮要分 base 个）
      // dir:   当前方向
      // 每来一个 subagent：从 panes[pos] 分 → 新 pane 追加到列表尾
      // pos 走完 base 个后 → 翻转方向，重置 pos，更新 base
      let state: { panes: string[]; pos: number; base: number; dir: "right" | "down" } = {
        panes: [], pos: 0, base: 0, dir: "right",
      };
      try {
        state = JSON.parse(readFileSync(markerFile, "utf8"));
      } catch {}

      // 首次：split-right from parent
      if (state.panes.length === 0) {
        // 必须从 agent 启动时的 pane 拆，不能 fallback 到当前焦点 pane。
        // 如果 MUXY_PANE_ID 没注入（pi 是从 muxy 外面启动的，或模块加载时 env 尚未注入），
        // 抛错让用户明确知道根因，而不是静默从当前激活 pane 拆出。
        if (!AGENT_MUXY_PANE_ID) {
          throw new Error(
            "MUXY_PANE_ID not set; cannot determine parent pane for first subagent split. " +
            "Start pi inside Muxy so MUXY_PANE_ID is injected at launch.",
          );
        }
        const args = ["split-right", "--from", AGENT_MUXY_PANE_ID];
        lastSplitSource = AGENT_MUXY_PANE_ID;
        muxLog(
          `[muxy split] mode=first dir=right from=AGENT_MUXY_PANE_ID=${AGENT_MUXY_PANE_ID} new=<pending> name=${JSON.stringify(name)}\n`,
        );
        const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();
        if (output) {
          state.panes = [output];
          state.pos = 0;
          state.base = 1;
          state.dir = "down";
          writeFileSync(markerFile, JSON.stringify(state));
          renameMuxySurface(output, name);
          muxLog(
            `[muxy split] mode=first dir=right from=AGENT_MUXY_PANE_ID=${AGENT_MUXY_PANE_ID} new=${output} name=${JSON.stringify(name)}\n`,
          );
        }
        return output;
      }

      // 本轮结束？翻转方向
      if (state.pos >= state.base) {
        state.pos = 0;
        state.base = state.panes.length;
        state.dir = state.dir === "right" ? "down" : "right";
      }

      const targetPane = state.panes[state.pos];
      lastSplitSource = targetPane ?? null;
      const muxyDir = state.dir === "right" ? "split-right" : "split-down";
      const args = [muxyDir];
      if (targetPane) args.push("--from", targetPane);

      muxLog(
        `[muxy split] mode=next pos=${state.pos} base=${state.base} dir=${state.dir} from=state.panes[${state.pos}]=${targetPane} new=<pending> name=${JSON.stringify(name)}\n`,
      );
      const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();

      if (output) {
        state.panes.push(output);
        state.pos++;
        writeFileSync(markerFile, JSON.stringify(state));
        renameMuxySurface(output, name);
        muxLog(
          `[muxy split] mode=next pos=${state.pos - 1} base=${state.base} dir=${state.dir} from=state.panes[${state.pos - 1}]=${targetPane} new=${output} name=${JSON.stringify(name)}\n`,
        );
      }

      return output;
    } finally {
      try { rmSync(lockFile); } catch {}
    }
  }

  if (backend === "cmux") {
    lastSplitSource = process.env.CMUX_SURFACE_ID ?? null;
    const created = createCmuxSplitSurface(name, "right", process.env.CMUX_SURFACE_ID);
    cmuxSubagentPane = created.paneRef ?? null;
    return created.surface;
  }

  if (backend === "zellij") {
    return createZellijSurface(name);
  }

  if (backend === "herdr") {
    return createHerdrSurface(name);
  }

  if (backend === "otty") {
    lastSplitSource = AGENT_OTTY_PANE_ID ?? null;
    return createOttySurface(name);
  }

  // On tmux, target the parent pi's pane so splits follow the agent, not the user's focus.
  // See https://github.com/HazAT/pi-interactive-subagents/issues/12
  const fromSurface = backend === "tmux" ? process.env.TMUX_PANE : undefined;
  lastSplitSource = fromSurface ?? null;
  return createSurfaceSplit(name, "right", fromSurface);
}

/**
 * Create a new surface (tab) in an existing cmux pane.
 */
function createSurfaceInPane(name: string, pane: string): string {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  let child: CmuxCreatedSurface | null = null;

  try {
    const output = execFileSync("cmux", ["new-surface", "--pane", pane], { encoding: "utf8" }).trim();
    child = parseCmuxCreatedSurface(output, "new-surface");
    child.paneRef ??= pane;
    renameCmuxSurface(child.surface, name);
    return child.surface;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        callerSnapshot,
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot);
    }
  }
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (`surface:42` in cmux, `%12` in tmux, `pane:7` in zellij, `42` in wezterm).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMuxBackend();

  if (backend === "muxy") {
    const dir = direction === "down" || direction === "up" ? "down" : "right";
    // 优先用入参 fromSurface（与 cmux/zellij/tmux/wezterm 保持一致），fallback 到
    // agent 启动时的 pane。两者都没有就抛错，避免静默 fallback 到当前焦点 pane。
    const sourcePane = fromSurface ?? AGENT_MUXY_PANE_ID;
    const sourceOrigin = fromSurface
      ? `fromSurface=${fromSurface}`
      : `AGENT_MUXY_PANE_ID=${AGENT_MUXY_PANE_ID ?? "<unset>"}`;
    if (!sourcePane) {
      throw new Error(
        "MUXY_PANE_ID not set and no fromSurface provided; cannot determine source pane for split. " +
        "Start pi inside Muxy so MUXY_PANE_ID is injected at launch.",
      );
    }
    const args = [`split-${dir}`, "--from", sourcePane];
    lastSplitSource = sourcePane;
    muxLog(
      `[muxy split] mode=createSurfaceSplit dir=${dir} from=${sourcePane} (${sourceOrigin}) new=<pending> name=${JSON.stringify(name)}\n`,
    );
    const output = execFileSync("muxy", args, { encoding: "utf8" }).trim();
    if (output) {
      renameMuxySurface(output, name);
      muxLog(
        `[muxy split] mode=createSurfaceSplit dir=${dir} from=${sourcePane} (${sourceOrigin}) new=${output} name=${JSON.stringify(name)}\n`,
      );
    }
    return output;
  }

  if (backend === "cmux") {
    return createCmuxSplitSurface(name, direction, fromSurface).surface;
  }

  if (backend === "tmux") {
    const args = ["split-window", "-d"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (fromSurface) {
      args.push("-t", fromSurface);
    }
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }

    return pane;
  }

  if (backend === "wezterm") {
    const args = ["cli", "split-pane"];
    if (direction === "left") args.push("--left");
    else if (direction === "right") args.push("--right");
    else if (direction === "up") args.push("--top");
    else args.push("--bottom");
    args.push("--cwd", process.cwd());
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
    if (!paneId || !/^\d+$/.test(paneId)) {
      throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
    }
    try {
      execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
        encoding: "utf8",
      });
    } catch {
      // Optional — tab title is cosmetic.
    }
    return paneId;
  }

  if (backend === "herdr") {
    const sourcePane = fromSurface ?? AGENT_HERDR_PANE_ID;
    if (!sourcePane) {
      throw new Error(
        "HERDR_PANE_ID not set and no fromSurface provided; cannot determine source pane for split. " +
          "Start pi inside herdr so HERDR_PANE_ID is injected at launch.",
      );
    }
    lastSplitSource = sourcePane;
    return splitHerdrPane(sourcePane, direction, name);
  }

  if (backend === "otty") {
    // otty 用 --direction right|down|left|up + --pane <parent>，且不返回新 pane id。
    // createOttySurface 内部用广度优先策略，对外只暴露"加一个 pane"。
    // 这里为了接口一致（返回 surface id），调用 createOttySurface
    // 并把 fromSurface / direction 作为 hint 注入。
    // 注：direction 在 otty 的广度优先策略中被忽略（顺序固定），
    // 但 fromSurface 会作为 fallback parent（如果提供）。
    lastSplitSource = fromSurface ?? AGENT_OTTY_PANE_ID ?? null;
    return createOttySurface(name);
  }

  // zellij
  const directionArg = direction === "left" || direction === "right" ? "right" : "down";
  const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

  let rawId: string;
  try {
    rawId = zellijActionSync(args, fromSurface).trim();
  } catch {
    if (!fromSurface) throw new Error("Failed to create zellij pane");
    rawId = zellijActionSync(args).trim();
  }

  // zellij returns the pane ID as e.g. "terminal_7" — extract the numeric part.
  // Previously we sent `write-chars "echo $ZELLIJ_PANE_ID"` to a temp file, but
  // `write-chars` without --pane-id targets the focused pane, which raced on tab switches.
  const surface = parseZellijPaneSurface(rawId, "new-pane");

  if (direction === "left" || direction === "up") {
    try {
      zellijActionSync(["move-pane", direction], surface);
    } catch {
      // Optional layout polish.
    }
  }

  try {
    zellijActionSync(["rename-pane", name], surface);
  } catch {
    // Optional.
  }

  return surface;
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  if (isHeadlessMode()) return; // no tab to rename

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "muxy") {
    const paneId = AGENT_MUXY_PANE_ID;
    if (!paneId) throw new Error("MUXY_PANE_ID not set");
    execFileSync("muxy", ["rename-pane", "--pane", paneId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-tab-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    execFileSync("wezterm", args, { encoding: "utf8" });
    return;
  }

  if (backend === "herdr") {
    // herdr 中 agent 自己 pane 的 tab 名就是用户最关心的。
    renameHerdrTab(AGENT_HERDR_PANE_ID ?? "", title);
    return;
  }

  if (backend === "otty") {
    // 与 herdr 一致：重命名 agent 自己 pane 所属的 tab，避免覆盖用户的 tab title。
    renameOttyTab(AGENT_OTTY_PANE_ID ?? "", title);
    return;
  }

  // zellij: rename the agent's own pane, not the whole tab. In multi-pane layouts,
  // rename-tab clobbers the user's tab title whenever a subagent starts or /plan runs.
  // Closes #21.
  const paneId = process.env.ZELLIJ_PANE_ID;
  if (paneId) {
    zellijActionSync(["rename-pane", title], `pane:${paneId}`);
  } else {
    zellijActionSync(["rename-pane", title]);
  }
}

/**
 * Rename the agent pane itself when no tab concept exists. For herdr we
 * delegate to renameHerdrTab which targets the pane's containing tab.
 */
export { renameHerdrTab };

/**
 * 重命名指定 surface（跨后端统一）。
 * headless surface 无实体 pane，直接 no-op。
 */
export function renameSurface(surface: string, name: string): void {
  if (isHeadlessSurface(surface)) return;

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    renameCmuxSurface(surface, name);
    return;
  }
  if (backend === "muxy") {
    renameMuxySurface(surface, name);
    return;
  }
  if (backend === "tmux") {
    // tmux 没有 pane 级命名，退化为所在 window 命名（调用方只对自建 surface 使用）
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{window_id}"], {
      encoding: "utf8",
    }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, name], { encoding: "utf8" });
    return;
  }
  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", surface, name], {
      encoding: "utf8",
    });
    return;
  }
  if (backend === "herdr") {
    renameHerdrPane(surface, name);
    return;
  }
  if (backend === "otty") {
    renameOttyTab(surface, name);
    return;
  }
  // zellij
  zellijActionSync(["rename-pane", name], surface);
}

/**
 * Rename the agent display name on a subagent surface (left sidebar title in herdr).
 * This requires the agent to be detected first, so call it after pi starts.
 * Silently no-ops on non-herdr backends or if the agent hasn't been detected yet.
 */
export function renameAgent(surface: string, name: string): void {
  if (isHeadlessMode()) return;
  const backend = getMuxBackend();
  if (backend === "herdr") {
    renameHerdrAgent(surface, name);
  }
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  if (isHeadlessMode()) return; // no workspace to rename

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "muxy") {
    // Muxy doesn't have a separate workspace concept; rename is handled at pane level
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }

    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-window-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    try {
      execFileSync("wezterm", args, { encoding: "utf8" });
    } catch {
      // Optional — window title is cosmetic.
    }
    return;
  }

  if (backend === "herdr") {
    renameHerdrWorkspace(title);
    return;
  }

  if (backend === "otty") {
    // Otty 没有显式 workspace rename 命令；rename-tab 已在 renameCurrentTab 中调用。
    return;
  }

  // Skip session rename for zellij. rename-session renames the socket file
  // but the ZELLIJ_SESSION_NAME env var in the parent process keeps the old
  // name, so all subsequent `zellij action ...` CLI calls fail with
  // "There is no active session!" because the CLI can't find the socket.
  // Additionally, pi titles often contain special characters (em dashes,
  // spaces) that fail zellij's session name validation on lookup.
  // rename-tab (called separately) is sufficient for user-visible naming.
}

/**
 * Re-export herdr workspace rename so callers can swap implementations by backend.
 * Internal: gated by PI_SUBAGENT_RENAME_HERDR_WORKSPACE env var.
 */
export { renameHerdrWorkspace };

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  // Headless mode: commands are sent via sendLongCommand which spawns the process directly.
  // Standalone sendCommand on a headless surface is a no-op — there's no running pane to send to.
  if (isHeadlessSurface(surface)) {
    return;
  }

  const backend = requireMuxBackend();

  if (backend === "cmux" || backend === "muxy") {
    if (backend === "muxy") {
      execFileSync("muxy", ["send", "--pane", surface, command], { encoding: "utf8" });
      execFileSync("muxy", ["send-keys", "--pane", surface, "Enter"], { encoding: "utf8" });
      return;
    }
    execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync(
      "wezterm",
      ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"],
      { encoding: "utf8" },
    );
    return;
  }

  if (backend === "herdr") {
    sendHerdrCommand(surface, command);
    return;
  }

  if (backend === "otty") {
    sendOttyCommand(surface, command);
    return;
  }

  zellijActionSync(["write-chars", command], surface);
  zellijActionSync(["write", "13"], surface);
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  if (isHeadlessSurface(surface)) {
    sendHeadlessEscape(surface);
    return;
  }

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execFileSync("cmux", ["send", "--surface", surface, "\u001b"], { encoding: "utf8" });
    return;
  }

  if (backend === "muxy") {
    // Use send (raw bytes) instead of send-keys Escape — send-keys may not
    // correctly translate the "Escape" key name to an actual ESC at the PTY level.
    // This matches how cmux and wezterm send the actual escape character (0x1B).
    execFileSync("muxy", ["send", "--pane", surface, "\u001b"], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", "\u001b"], {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "herdr") {
    sendHerdrEscape(surface);
    return;
  }

  if (backend === "otty") {
    sendOttyEscape(surface);
    return;
  }

  zellijActionSync(["write", "27"], surface);
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  // Headless mode: spawn as a background child process instead of sending to a mux pane
  if (isHeadlessSurface(surface)) {
    const logFile = options?.scriptPath
      ? options.scriptPath.replace(/\.sh$/, ".log")
      : undefined;
    // Write the script file for debugging even in headless mode
    const scriptPath =
      options?.scriptPath ??
      join(
        tmpdir(),
        "pi-subagent-scripts",
        `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
      );
    mkdirSync(dirname(scriptPath), { recursive: true });
    const scriptParts = ["#!/bin/bash"];
    if (options?.scriptPreamble) {
      scriptParts.push(options.scriptPreamble.trimEnd());
    }
    scriptParts.push(command);
    writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });

    spawnHeadlessProcess(surface, "subagent", `bash ${shellEscape(scriptPath)}`, {
      cwd: process.cwd(),
      env: { PI_SUBAGENT_HEADLESS: "1" },
    });
    return scriptPath;
  }

  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  if (isHeadlessSurface(surface)) {
    return readHeadlessScreen(surface, lines);
  }

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    return execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, {
      encoding: "utf8",
    });
  }

  if (backend === "muxy") {
    return execFileSync("muxy", ["read-screen", "--pane", surface, "--lines", String(lines)], {
      encoding: "utf8",
    });
  }

  if (backend === "tmux") {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      {
        encoding: "utf8",
      },
    );
  }

  if (backend === "wezterm") {
    const raw = execFileSync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(raw, lines);
  }

  if (backend === "herdr") {
    // 用 recent 读最近 scrollback，确保 sentinel 检测可靠。
    // visible 只读当前 viewport，pi 退出后终端恢复主缓冲区，sentinel 可能不在 viewport 内，
    // 导致 pollForExit 检测不到退出、closeSurface 不执行、分屏关不掉。
    return readHerdrScreen(surface, lines, "recent");
  }

  if (backend === "otty") {
    return readOttyScreen(surface, lines);
  }

  // Zellij 0.44+: use --pane-id flag + stdout instead of env var + temp file.
  // The ZELLIJ_PANE_ID env var doesn't reliably target other panes for dump-screen,
  // and --path may silently fail to create the file. Stdout capture is robust.
  const paneId = zellijPaneId(surface);
  const raw = execFileSync(
    "zellij",
    ["action", "dump-screen", "--pane-id", paneId],
    { encoding: "utf8" },
  );
  return tailLines(raw, lines);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  if (isHeadlessSurface(surface)) {
    return readHeadlessScreen(surface, lines);
  }

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    const { stdout } = await execFileAsync(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", String(lines)],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "muxy") {
    const { stdout } = await execFileAsync(
      "muxy",
      ["read-screen", "--pane", surface, "--lines", String(lines)],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "tmux") {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  }

  if (backend === "wezterm") {
    const { stdout } = await execFileAsync(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" },
    );
    return tailLines(stdout, lines);
  }

  if (backend === "herdr") {
    return readHerdrScreen(surface, lines, "recent");
  }

  if (backend === "otty") {
    return readOttyScreen(surface, lines);
  }

  // Zellij 0.44+: use --pane-id flag + stdout instead of env var + temp file.
  const paneId = zellijPaneId(surface);
  const { stdout } = await execFileAsync(
    "zellij",
    ["action", "dump-screen", "--pane-id", paneId],
    { encoding: "utf8" },
  );
  return tailLines(stdout, lines);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  if (isHeadlessSurface(surface)) {
    closeHeadlessSurface(surface);
    return;
  }

  const backend = requireMuxBackend();

  if (backend === "cmux") {
    execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
      encoding: "utf8",
    });
    return;
  }

  if (backend === "muxy") {
    execFileSync("muxy", ["close-pane", "--pane", surface], { encoding: "utf8" });
    // 从 state.panes 移除已关闭的 subagent，避免僵尸 ID 累积导致
    // 后续 `muxy split-* --from <死ID>` 走 fallback 行为（从当前焦点 pane 拆出）。
    // 解析 JSON 状态，splice 掉已关闭的 surface，pos 相应回退；
    // 全部 subagent 都关闭后删除整个 marker，下次创建走"首次"分支。
    const markerFile = `/tmp/muxy-subagent-pane-${AGENT_MUXY_PANE_ID || "default"}`;
    try {
      const parsed = JSON.parse(readFileSync(markerFile, "utf8"));
      if (parsed && Array.isArray(parsed.panes)) {
        const idx = parsed.panes.indexOf(surface);
        if (idx >= 0) {
          const beforePanes = [...parsed.panes];
          const beforePos = parsed.pos;
          parsed.panes.splice(idx, 1);
          // pos 指向"下一个要 split 的索引"，左侧删除时 pos 需要回退
          if (typeof parsed.pos === "number" && idx < parsed.pos) {
            parsed.pos = Math.max(0, parsed.pos - 1);
          }
          if (parsed.panes.length === 0) {
            rmSync(markerFile);
            muxLog(
              `[muxy close] pane=${surface} panes=${JSON.stringify(beforePanes)} -> [] pos=${beforePos} -> <marker-removed>\n`,
            );
          } else {
            writeFileSync(markerFile, JSON.stringify(parsed));
            muxLog(
              `[muxy close] pane=${surface} panes=${JSON.stringify(beforePanes)} -> ${JSON.stringify(parsed.panes)} pos=${beforePos} -> ${parsed.pos}\n`,
            );
          }
        } else {
          muxLog(
            `[muxy close] pane=${surface} (not in marker state.panes, marker unchanged)\n`,
          );
        }
      }
    } catch (e) {
      muxLog(
        `[muxy close] pane=${surface} (no marker found or parse error, nothing to clean)\n`,
      );
    }
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    return;
  }

  if (backend === "wezterm") {
    execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
      encoding: "utf8" },
    );
    return;
  }

  if (backend === "herdr") {
    closeHerdrSurface(surface);
    return;
  }

  if (backend === "otty") {
    closeOttySurface(surface);
    return;
  }

  zellijActionSync(["close-pane"], surface);
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "structured_output" | "sentinel";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Validated structured output if reason is "structured_output" */
  structuredOutput?: unknown;
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  const isHeadless = isHeadlessSurface(surface);

  for (;;) {
    if (signal.aborted) {
      muxLog(`[pollForExit] ABORTED at loop start surface=${surface} elapsed=${Date.now() - start}ms — signal was aborted before/synchronously after watchSubagent entered poll loop (likely stale POLL_ABORT_KEY controller). Throwing "Aborted while waiting..."\n`);
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping / structured_output)
    if (options.sessionFile) {
      const exitFile = `${options.sessionFile}.exit`;
      try {
        if (existsSync(exitFile)) {
          let data: any;
          try {
            data = JSON.parse(readFileSync(exitFile, "utf8"));
          } catch (parseErr: any) {
            // .exit 文件存在但解析失败 — subagent 可能被 SIGKILL 半截写入。
            // 不删文件，留着供事后诊断；下次循环再试一次，如果始终半截则由超时兜底。
            muxLog(
              `[pollForExit] FAST PATH BUG: ${exitFile} exists but JSON.parse failed: ${parseErr?.message ?? String(parseErr)}\n` +
                `[pollForExit] contents(raw)=${JSON.stringify((() => { try { return readFileSync(exitFile, "utf8"); } catch { return "<unreadable>"; } })())}\n`,
            );
            throw parseErr; // 跳到外层 catch 不静默吞
          }
          // 双重确认：子 pi 进程必须已启动（.jsonl 存在 + 非空）。
          // 防止 herdr 后端在子 pi 根本没启动时 existsSync 假阳性命中
          // 残留 .exit 文件，导致 6ms/28ms 内 false positive return。
          const sessionJsonl = options.sessionFile;
          try {
            if (!existsSync(sessionJsonl) || statSync(sessionJsonl).size === 0) {
              rmSync(exitFile, { force: true });
              muxLog(
                `[pollForExit] fast path FALSE POSITIVE: ${exitFile} type=${data?.type} but ${sessionJsonl} is ` +
                  `${existsSync(sessionJsonl) ? `empty (0 bytes)` : `missing`} — subagent never started, ` +
                  `deleting stale .exit and continuing poll\n`,
              );
              // 跳到外层 sleep + 继续循环（不是 return）
              throw Object.assign(new Error("subprocess not started"), { code: "SUBPROCESS_NOT_STARTED" });
            }
          } catch (e2: any) {
            if (e2?.code === "SUBPROCESS_NOT_STARTED") throw e2;
            // stat 失败不影响 — 继续正常 fast path
            muxLog(`[pollForExit] session jsonl check failed (non-fatal): ${e2?.message ?? String(e2)}\n`);
          }
          rmSync(exitFile, { force: true });
          muxLog(`[pollForExit] fast path hit exitFile=${exitFile} type=${data?.type}\n`);
          if (data.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
          }
          if (data.type === "structured_output") {
            return { reason: "structured_output", exitCode: 0, structuredOutput: data.value };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch (e: any) {
        if (e?.code === "SUBPROCESS_NOT_STARTED") {
          // 不是真正的错误 — .exit 是残留文件，已删除。继续 slow path。
          // 这里不 return，让循环继续到 slow path 轮询。
        } else if (e?.code !== "ENOENT") {
          muxLog(
            `[pollForExit] fast path error sessionFile=${options.sessionFile} err=${e?.message ?? String(e)}\n`,
          );
        }
      }
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          muxLog(`[pollForExit] sentinel file hit path=${options.sentinelFile}\n`);
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch (e: any) {
        muxLog(
          `[pollForExit] sentinel file check error path=${options.sentinelFile} err=${e?.message ?? String(e)}\n`,
        );
      }
    }

    // Headless mode: check if the child process has exited
    if (isHeadless) {
      const headlessExit = getHeadlessProcessExit(surface);
      if (headlessExit) {
        const { exitCode } = await Promise.race([
          headlessExit,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 100),
          ),
        ]).catch(() => ({ exitCode: null as number | null }));
        if (exitCode !== null && exitCode !== undefined) {
          drainHeadlessProcess(surface);
          return { reason: "sentinel", exitCode };
        }
      }
    }

    // Slow path: read terminal screen for sentinel (crash detection).
    // 后台 tab 的 herdr 可能节流/陈旧化屏幕 buffer，所以多读一些行提高命中率。
    if (!isHeadless) {
      let screen = "";
      let readErr: unknown = null;
      try {
        screen = await readScreenAsync(surface, 200);
      } catch (e) {
        readErr = e;
      }

      if (readErr) {
        // Surface may have been destroyed — check if .exit file appeared in the meantime
        muxLog(
          `[pollForExit] slow path read screen FAILED surface=${surface} err=${(readErr as Error)?.message ?? String(readErr)}\n`,
        );
        if (options.sessionFile) {
          const exitFile = `${options.sessionFile}.exit`;
          try {
            if (existsSync(exitFile)) {
              const data = JSON.parse(readFileSync(exitFile, "utf8"));
              rmSync(exitFile, { force: true });
              muxLog(`[pollForExit] recovery via .exit after screen read failure file=${exitFile} type=${data?.type}\n`);
              if (data.type === "ping") {
                return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
              }
              if (data.type === "structured_output") {
                return { reason: "structured_output", exitCode: 0, structuredOutput: data.value };
              }
              return { reason: "done", exitCode: 0 };
            }
          } catch (e2: any) {
            muxLog(
              `[pollForExit] recovery .exit check FAILED file=${exitFile} err=${e2?.message ?? String(e2)}\n`,
            );
          }
        }
      } else {
        const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
        if (match) {
          muxLog(`[pollForExit] slow path sentinel hit surface=${surface} exitCode=${match[1]}\n`);
          return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
        }
        // 每 10 秒记一次屏幕尾部快照，方便事后看到底是屏幕没更新还是 sentinel 滚出。
        if (Date.now() - start > 0 && Math.floor((Date.now() - start) / 1000) % 10 === 0) {
          muxLog(
            `[pollForExit] slow path no sentinel surface=${surface} tail=${JSON.stringify(screen.slice(-200))}\n`,
          );
        }
      }
    } else if (options.sessionFile) {
      // Headless mode: check .exit sidecar as fallback in case process exited without sidecar
      const exitFile = `${options.sessionFile}.exit`;
      try {
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          muxLog(`[pollForExit] headless .exit hit file=${exitFile} type=${data?.type}\n`);
          if (data.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
          }
          if (data.type === "structured_output") {
            return { reason: "structured_output", exitCode: 0, structuredOutput: data.value };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch (e: any) {
        muxLog(
          `[pollForExit] headless .exit check FAILED file=${exitFile} err=${e?.message ?? String(e)}\n`,
        );
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
