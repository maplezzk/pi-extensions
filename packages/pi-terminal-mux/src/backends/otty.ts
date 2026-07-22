/**
 * otty.ts — Otty 终端模拟器 backend for pi-interactive-subagents
 *
 * Otty 是一个 macOS 终端模拟器（参见 https://otty.sh / https://docs.otty.sh）。
 * 与 cmux / tmux / zellij / wezterm / herdr 类似，它通过 `otty` CLI 提供
 * pane / tab / window 编程化控制能力。
 *
 * 与其他 backend 的关键差异：
 *   1. Otty 不像 cmux 那样注入 `CMUX_SURFACE_ID`。当前 agent pane id 需要
 *      通过 `otty panes --json` 查询 "active=true" 的 pane 来获取，并在
 *      模块加载时冻结到常量。
 *   2. `otty pane send-keys` 默认 disabled（需要 `ipc-allow-send-keys = true`）。
 *      backend 启动时会检测该开关，未启用时 setup hint 提示用户。
 *   3. `otty pane close --pane <id>` 在 v1.0.4 行为不稳定（实测仅打印 "Pane split"
 *      但 pane 列表未变）。close 走 best-effort 路径：先 close pane，失败/超时
 *      时降级为 close tab，最后兜底为 log warn 不 throw —— 避免 pollForExit 退出
 *      流程被 close 错误打断。
 *   4. pane id 是字符串（如 `p_19eefc5b4a2_11`），不像 tmux 是 `%12`。
 *
 * Otty 关键 IPC 接口（参见 https://docs.otty.sh/reference/cli）：
 *   - `otty panes --json`                    列出所有 pane
 *   - `otty pane split --direction <dir> --pane <id> --no-focus --command <cmd> --title <name>`
 *   - `otty pane send-keys --pane <id> -- "..." key:Enter`
 *   - `otty pane send-keys --pane <id> -- key:Escape`
 *   - `otty pane capture --pane <id> --lines <N>`
 *   - `otty pane close --pane <id> [--force]`
 *   - `otty pane focus <id>`
 *   - `otty tab list --json`                 列出所有 tab
 *   - `otty tab rename --tab <tab_id> <title>`
 *   - `otty tab close <tab_id>`
 *
 * 日志、文件锁、BFS 分屏状态机、命令检测复用 backends/shared.ts。
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { i18n } from "../i18n.ts";
import { createBackendLogger, withFileLock, BfsSplitStateManager, hasCommand } from "./shared.ts";

// ── 日志（统一格式，写入 /tmp/pi-mux-otty.log） ──
const ottyLog = createBackendLogger("otty", "/tmp/pi-mux-otty.log");

// ── Otty 检测 ──

/**
 * 检测 otty backend 是否可用：
 *   1. `otty` 命令在 PATH 中
 *   2. 当前进程在 Otty 终端内运行（TERM_PROGRAM=otty）
 *   3. Otty 应用正在运行（`otty panes --json` 成功）
 *
 * 注意：cwd 不在 `/Applications/Otty.app` 内（这是 app bundle 路径，
 * Otty CLI 不在那里执行），所以只看 env 与 CLI 可用性。
 */
export function isOttyRuntimeAvailable(): boolean {
  if (process.env.TERM_PROGRAM !== "otty") return false;
  if (!hasCommand("otty")) return false;

  // 最后一道闸：otty 命令存在但 app 没启动时 `otty panes` 会失败。
  // 提前 500ms 超时探一下，避免后续每次调用都等满 3s。
  try {
    const result = spawnSync("otty", ["panes", "--json", "--timeout", "500"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) return false;
    return Boolean(result.stdout.trim());
  } catch {
    return false;
  }
}

/**
 * send-keys 在 otty 默认 disabled。
 * 提前检测一次（缓存），避免每次 sendCommand 都试一遍并抛错。
 */
let sendKeysEnabledCache: boolean | null = null;

export function isOttySendKeysEnabled(): boolean {
  if (sendKeysEnabledCache !== null) return sendKeysEnabledCache;
  try {
    // 用一个无害探针：给 agent 自己 pane 发 key:End，看 otty 是否允许 send-keys。
    const result = spawnSync(
      "otty",
      ["pane", "send-keys", "--pane", getOttyAgentPaneId(), "--", "key:End"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const enabled = result.status === 0;
    sendKeysEnabledCache = enabled;
    if (!enabled) {
      ottyLog(
        `[detect] send-keys DISABLED stderr=${JSON.stringify((result.stderr ?? "").trim().slice(0, 200))}`,
      );
    }
    return enabled;
  } catch (e) {
    sendKeysEnabledCache = false;
    ottyLog(`[detect] send-keys probe failed: ${(e as Error).message}`);
    return false;
  }
}

// ── Agent pane id 缓存 ──

/**
 * 捕获于模块加载时的 agent pane id。
 * Otty 不像 cmux 那样注入 surface id；需要在启动时通过 `otty panes --json`
 * 找 `active=true` 的 pane 并冻结到常量。
 *
 * 如果暂时拿不到（Otty 刚启动、panes 还没列出来），返回 null，
 * 调用方在第一次 createSurface 时重试。
 */
export const AGENT_OTTY_PANE_ID: string | null = (() => {
  try {
    const panes = readOttyPanes();
    // active=true 是当前 focus pane。但用户启动 pi 后焦点可能在 pi pane，
    // 也可能在另一个 pane —— 必须按 process 名称筛选。
    const piPane = panes.find((p) => p.active && /(^|\s)(π|pi)($|\s|-)/i.test(p.process));
    if (piPane) return piPane.id;
    // 退路：取 active=true 的 pane（不严谨，但能跑）
    const active = panes.find((p) => p.active);
    return active?.id ?? null;
  } catch (e) {
    ottyLog(`[init] failed to capture agent pane id: ${(e as Error).message}`);
    return null;
  }
})();

/**
 * 获取 agent pane id，必要时重试。
 * 用于 AGENT_OTTY_PANE_ID 启动时为 null 的情况（panes 还没就绪），
 * 以及 pane 失效后的 fallback。
 */
export function getOttyAgentPaneId(): string {
  if (AGENT_OTTY_PANE_ID && ottyPaneExists(AGENT_OTTY_PANE_ID)) {
    return AGENT_OTTY_PANE_ID;
  }

  // 重试一次
  const refreshed = (() => {
    try {
      const panes = readOttyPanes();
      const piPane = panes.find((p) => p.active && /(^|\s)(π|pi)($|\s|-)/i.test(p.process));
      if (piPane) return piPane.id;
      return panes.find((p) => p.active)?.id ?? null;
    } catch {
      return null;
    }
  })();
  if (refreshed) return refreshed;
  throw new Error(
    "Could not determine Otty agent pane id. " +
      "Make sure Otty is running and `otty panes --json` returns a list.",
  );
}

function ottyPaneExists(paneId: string): boolean {
  try {
    return readOttyPanes().some((p) => p.id === paneId);
  } catch {
    return false;
  }
}

// ── Otty CLI 调用的薄封装 ──

/**
 * 调用 `otty` 命令并返回 stdout。
 * 失败时 stderr 写入 log，原样抛错（调用方决定如何处理）。
 */
function ottyExec(args: string[]): string {
  const cmdline = `otty ${args
    .map((a) => (a.includes(" ") || a.includes('"') ? JSON.stringify(a) : a))
    .join(" ")}`;
  ottyLog(`[exec] ${cmdline}`);
  const result = spawnSync("otty", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    ottyLog(`[exec] ERROR (spawn): ${result.error.message}`);
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    ottyLog(`[exec] ERROR status=${result.status} stderr=${JSON.stringify(stderr)}`);
    throw new Error(`otty ${args[0]} failed (status=${result.status}): ${stderr}`);
  }
  ottyLog(`[exec] -> ${JSON.stringify(result.stdout.trim().slice(0, 200))}`);
  return result.stdout;
}

/**
 * 调用 `otty` 命令，丢弃 stdout。用于 sendCommand / sendKeys / closePane 这类
 * 无输出的命令。
 */
function ottyExecSilent(args: string[]): void {
  const cmdline = `otty ${args
    .map((a) => (a.includes(" ") || a.includes('"') ? JSON.stringify(a) : a))
    .join(" ")}`;
  ottyLog(`[exec silent] ${cmdline}`);
  const result = spawnSync("otty", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    ottyLog(
      `[exec silent] ERROR status=${result.status} stderr=${JSON.stringify(
        (result.stderr ?? "").trim().slice(0, 200),
      )}`,
    );
  }
}

// ── Pane 数据结构 ──

export interface OttyPaneSnapshot {
  id: string;
  tab_id: string;
  window_id: string;
  index: number;
  active: boolean;
  cwd: string;
  process: string;
  cols: number;
  rows: number;
}

interface OttyListResponse<T> {
  ok: boolean;
  command: string;
  data: T;
}

export function parseOttyJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    ottyLog(`[parse json] failed: ${(e as Error).message} raw=${JSON.stringify(trimmed.slice(0, 200))}`);
    return null;
  }
}

export function readOttyPanes(): OttyPaneSnapshot[] {
  const raw = ottyExec(["panes", "--json"]);
  const parsed = parseOttyJson(raw) as OttyListResponse<OttyPaneSnapshot[]> | null;
  if (!parsed?.ok || !Array.isArray(parsed.data)) return [];
  return parsed.data;
}

export function readOttyTabs(): Array<Record<string, unknown>> {
  try {
    const raw = ottyExec(["tab", "list", "--json"]);
    const parsed = parseOttyJson(raw) as OttyListResponse<Array<Record<string, unknown>>> | null;
    if (!parsed?.ok || !Array.isArray(parsed.data)) return [];
    return parsed.data;
  } catch (e) {
    ottyLog(`[tabs] list failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * 从 pane id 解析 tab id。
 * 优先走 `panes --json` 反查（无需走 tab list），回退到 panes-by-id 查找。
 */
export function getTabIdForPane(paneId: string): string | null {
  try {
    const pane = readOttyPanes().find((p) => p.id === paneId);
    return pane?.tab_id ?? null;
  } catch {
    return null;
  }
}

// ── BFS 分屏状态 marker 路径（复用 shared.ts 状态机） ──
//
// 与 muxy / herdr 同样的广度优先分屏策略。marker 文件落在 os.tmpdir()
// （otty 历史路径，保持不动），锁与状态机逻辑由 shared.ts 提供。

function ottyStateFile(): string {
  const agentId = AGENT_OTTY_PANE_ID ?? "default";
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${tmpdir()}/otty-subagent-pane-${safe}.json`;
}

/**
 * 找到 split 后的新 pane id。
 *
 * Otty 的 `pane split --pane <parent>` 把目标 pane 拆成两个，但返回的
 * stdout 在 v1.0.4 不会输出新 pane id —— 必须通过比较 split 前后的
 * `otty panes --json` 列表差集来推断。
 *
 * 为了避免并发竞争（两次 split 之间有人插队），先记下 split 前的 pane id 集合，
 * split 后差集 = 新 pane id。
 */
function capturePaneIds(): Set<string> {
  return new Set(readOttyPanes().map((p) => p.id));
}

function diffNewPane(before: Set<string>): string | null {
  try {
    const after = readOttyPanes();
    const newOnes = after.filter((p) => !before.has(p.id));
    if (newOnes.length === 0) return null;
    if (newOnes.length === 1) return newOnes[0]!.id;
    // 多于 1 个 → 取最后出现（split 后追加的通常在尾部）
    ottyLog(`[diff] multiple new panes after split: ${JSON.stringify(newOnes.map((p) => p.id))}`);
    return newOnes[newOnes.length - 1]!.id;
  } catch (e) {
    ottyLog(`[diff] failed: ${(e as Error).message}`);
    return null;
  }
}

// ── 对外 API：createSurface ──

/**
 * 创建一个新的 subagent pane。
 *
 * 实现：广度优先分屏（与 muxy / herdr 一致），锁与状态机复用 shared.ts。
 * 第一次 split：从 agent pane 向右拆（--no-focus 保持 agent 焦点不变）。
 * 后续 split：按状态机轮转 right/down，绕圈拆分已有 subagent pane。
 *
 * 已知问题：
 *   - `otty pane split` v1.0.4 不返回新 pane id，必须靠 panes --json 差集推断。
 *   - 若 agent pane 失效（用户切换到别的 tab），getOttyAgentPaneId() 会抛错，
 *     createSurface 也跟着失败 —— 这是 fail-fast 设计，避免静默从错误位置拆。
 */
export function createOttySurface(name: string): string {
  const agentId = getOttyAgentPaneId();

  // send-keys 没开时无法在子 pane 里发送 Enter，必须改用 --command 注入启动命令。
  if (!isOttySendKeysEnabled()) {
    ottyLog(`[create] send-keys disabled; createSurface will succeed but pane will be empty until otty config enables it`);
  }

  const markerFile = ottyStateFile();
  const lockPath = `${markerFile}.lock`;

  return withFileLock(lockPath, { timeoutMs: 3000 }, () => {
    let state = new BfsSplitStateManager(markerFile);

    // ── 首次 split ──
    if (state.panes().length === 0) {
      const before = capturePaneIds();
      try {
        ottyExec([
          "pane",
          "split",
          "--direction",
          "right",
          "--pane",
          agentId,
          "--no-focus",
          "--title",
          name,
        ]);
      } catch (e) {
        ottyLog(`[create] first split failed: ${(e as Error).message}`);
        return "";
      }
      const newId = diffNewPane(before);
      if (!newId) {
        ottyLog(`[create] first split produced no new pane id`);
        return "";
      }
      state.add(newId);
      renameOttyTab(newId, name);
      ottyLog(`[create] mode=first dir=right from=${agentId} new=${newId} name=${JSON.stringify(name)}`);
      return newId;
    }

    // ── 后续 split ──
    const next = state.next();
    if (!next) return "";

    let target = next.source;
    const direction = next.direction;

    const before = capturePaneIds();
    let splitSucceeded = false;
    let recovered = false;
    try {
      ottyExec([
        "pane",
        "split",
        "--direction",
        direction,
        "--pane",
        target,
        "--no-focus",
        "--title",
        name,
      ]);
      splitSucceeded = true;
    } catch (e) {
      // target 失效 → 重置 state，从 agent pane 重新拆
      ottyLog(`[create] pane ${target} gone (${(e as Error).message}), reset and retry from agent pane`);
      try {
        rmSync(markerFile);
      } catch {
        /* ignore */
      }
      state = new BfsSplitStateManager(markerFile); // marker 已删 → 空状态
      target = agentId;
      try {
        ottyExec([
          "pane",
          "split",
          "--direction",
          "right",
          "--pane",
          agentId,
          "--no-focus",
          "--title",
          name,
        ]);
        splitSucceeded = true;
        recovered = true;
      } catch (e2) {
        ottyLog(`[create] reset split failed: ${(e2 as Error).message}`);
        return "";
      }
    }

    if (!splitSucceeded) return "";
    const newId = diffNewPane(before);
    if (!newId) {
      ottyLog(`[create] next split produced no new pane id`);
      return "";
    }
    // 正常路径消费了状态机里的 source（advance）；recovery 路径用的是全新空状态，
    // split 源是 agent pane（不在状态机里），只需 add。
    if (!recovered) state.advance();
    state.add(newId);
    renameOttyTab(newId, name);
    ottyLog(`[create] mode=next dir=${direction} from=${target} new=${newId} name=${JSON.stringify(name)}`);
    return newId;
  });
}

// ── 对外 API：pane 操作 ──

/**
 * 给 pane 发送命令 + Enter。
 *
 * 关键限制：otty `pane send-keys` 默认 disabled（`ipc-allow-send-keys = true`）。
 * 若该选项未启用，本函数 noop + log warn，调用方应提示用户启用。
 *
 * 实现：使用 `pane send-keys --pane <id> -- "<text>" key:Enter`。
 * send-keys 接受任意数量 PARTS，可混合文本与 `key:Enter` 这种命名 key。
 */
export function sendOttyCommand(paneId: string, command: string): void {
  if (!isOttySendKeysEnabled()) {
    ottyLog(`[send] pane=${paneId} cmd=${JSON.stringify(command.slice(0, 80))} SKIPPED (send-keys disabled)`);
    return;
  }
  try {
    ottyExecSilent(["pane", "send-keys", "--pane", paneId, "--", command, "key:Enter"]);
  } catch (e) {
    ottyLog(`[send] pane=${paneId} cmd failed: ${(e as Error).message}`);
  }
}

/**
 * 给 pane 发送 Escape。
 * send-keys 支持 `key:Escape` 这种命名 key。
 */
export function sendOttyEscape(paneId: string): void {
  if (!isOttySendKeysEnabled()) {
    ottyLog(`[escape] pane=${paneId} SKIPPED (send-keys disabled)`);
    return;
  }
  try {
    ottyExecSilent(["pane", "send-keys", "--pane", paneId, "--", "key:Escape"]);
  } catch (e) {
    ottyLog(`[escape] pane=${paneId} failed: ${(e as Error).message}`);
  }
}

/**
 * 读取 pane 屏幕内容。
 * `otty pane capture --pane <id> --lines <N>` 直接打印文本（非 JSON）。
 */
export function readOttyScreen(paneId: string, lines = 50): string {
  try {
    return ottyExec(["pane", "capture", "--pane", paneId, "--lines", String(lines)]);
  } catch (e) {
    ottyLog(`[read] pane=${paneId} failed: ${(e as Error).message}`);
    return "";
  }
}

/**
 * 关闭 pane。
 *
 * v1.0.4 已知：直接 `pane close --pane <id>` 可能不生效。最佳策略：
 *   1. 先 `pane close --pane <id> --force`
 *   2. 100ms 后检查 pane 是否还在 panes 列表
 *   3. 若仍在，且 tab 里**只有这一个 pane**（孤立 tab），尝试 `tab close --tab <tab_id>`
 *      —— 关 tab 不会误伤其他 pane。
 *   4. 若 tab 里还有其他 pane（如 agent 自己的 pane），跳过 fallback，
 *      仅 log warn。否则会把 agent 自己的 pane 一起带走（参见实际事故：
 *      用户在测试时执行 `otty tab close t_xxx`，把同一个 tab 里的 pi 也关了）。
 *   5. 若都失败，log warn，不 throw（避免 pollForExit 退出流程被 close 错误打断）。
 *
 * 与 cmux/muxy 不同：otty 没有"我自己的 pane"概念，close 总是针对显式 id。
 */
export function closeOttySurface(paneId: string): void {
  const beforeIds = capturePaneIds();
  let closed = false;

  // 1. pane close --force
  try {
    ottyExecSilent(["pane", "close", "--pane", paneId, "--force"]);
    closed = true;
  } catch (e) {
    ottyLog(`[close] pane close failed: ${(e as Error).message}`);
  }

  // 2. 验证
  if (closed && beforeIds.has(paneId)) {
    spawnSync("sleep", ["0.1"]);
    const stillThere = capturePaneIds().has(paneId);
    if (!stillThere) {
      ottyLog(`[close] pane ${paneId} closed via pane close --force`);
      cleanupOttyStateForPane(paneId);
      return;
    }
  }

  // 3. fallback: 仅当 pane 是 tab 的唯一成员时才关整个 tab。
  // 否则关 tab 会把 agent pane 等其他 pane 也带走（实际事故）。
  ottyLog(`[close] pane close ineffective, considering tab close fallback`);
  const tabId = getTabIdForPane(paneId);
  if (tabId) {
    let panesInTab: OttyPaneSnapshot[] = [];
    try {
      panesInTab = readOttyPanes().filter((p) => p.tab_id === tabId);
    } catch {
      panesInTab = [];
    }
    const isLonelyTab = panesInTab.length <= 1;
    if (isLonelyTab) {
      try {
        ottyExecSilent(["tab", "close", tabId]);
        ottyLog(`[close] tab ${tabId} closed (lonely tab, safe)`);
      } catch (e) {
        ottyLog(`[close] tab close failed: ${(e as Error).message}`);
      }
    } else {
      ottyLog(
        `[close] pane=${paneId} tab=${tabId} has ${panesInTab.length} panes; ` +
          `skipping tab close to avoid clobbering other panes (agent pane is likely in this tab)`,
      );
    }
  }
  cleanupOttyStateForPane(paneId);
}

/**
 * 重命名 pane 对应的 tab。
 * Otty 没有"pane -> tab id"的直接命令，所以用 `panes --json` 反查 tab_id。
 */
export function renameOttyTab(paneId: string, name: string): void {
  const tabId = getTabIdForPane(paneId);
  if (!tabId) {
    ottyLog(`[rename] pane=${paneId} no tab id found`);
    return;
  }
  try {
    ottyExecSilent(["tab", "rename", "--tab", tabId, name]);
  } catch (e) {
    ottyLog(`[rename] pane=${paneId} tab=${tabId} name=${JSON.stringify(name)} failed: ${(e as Error).message}`);
  }
}

/**
 * 从 BFS 状态 marker 中清理已关闭的 pane（复用 shared.ts 状态机）。
 * 与 muxy / herdr 的 close 行为一致：避免僵尸 ID 累积导致后续 split 走错目标。
 */
function cleanupOttyStateForPane(paneId: string): void {
  try {
    const state = new BfsSplitStateManager(ottyStateFile());
    const beforePanes = state.panes();
    state.remove(paneId);
    const afterPanes = state.panes();
    if (beforePanes.length !== afterPanes.length) {
      ottyLog(
        `[close] pane=${paneId} panes=${JSON.stringify(beforePanes)} -> ${
          afterPanes.length === 0 ? "<marker-removed>" : JSON.stringify(afterPanes)
        }`,
      );
    }
  } catch {
    /* no marker or parse error, nothing to clean */
  }
}

// ── Setup hint ──

/**
 * Otty setup hint —— 用户没在 Otty 终端内 / 没启用 send-keys 时提示。
 *
 * 注意：TERM_PROGRAM=otty 已经检查通过才会调用本函数。
 * 这里只补充 send-keys 开关和 pane 创建失败的提示。
 */
export function ottySetupHint(): string {
  if (!isOttySendKeysEnabled()) {
    return i18n.t("setupHint.ottySendKeys");
  }
  return "";
}

// ── BackendOps 适配器（薄包装现有原生函数，行为语义见各函数注释） ──

import type { BackendOps } from "./types.ts";

/** BackendOps 适配器：所有方法薄包装 otty 原生函数 */
export const ops: BackendOps = {
  /** 创建 otty surface（内部用广度优先策略） */
  create(name: string): string {
    return createOttySurface(name);
  },
  /** 指定方向分屏（direction 在 otty 广度优先策略中忽略） */
  createSplit(name: string, _direction: "left" | "right" | "up" | "down", _fromSurface?: string): string {
    // otty 用广度优先策略，direction 参数被忽略；createOttySurface 内部处理所有逻辑。
    return createOttySurface(name);
  },
  /** 向 otty pane 发送命令并执行 */
  send(surface: string, command: string): void {
    sendOttyCommand(surface, command);
  },
  /** 向 otty pane 发送 Escape */
  sendEscape(surface: string): void {
    sendOttyEscape(surface);
  },
  /** 同步读取 otty pane 屏幕最后 N 行 */
  read(surface: string, lines = 50): string {
    return readOttyScreen(surface, lines);
  },
  /** 异步读取 otty pane 屏幕最后 N 行 */
  async readAsync(surface: string, lines = 50): Promise<string> {
    return readOttyScreen(surface, lines);
  },
  /** 关闭 otty pane */
  close(surface: string): void {
    closeOttySurface(surface);
  },
  /** 重命名 otty pane 所属 tab */
  rename(surface: string, name: string): void {
    renameOttyTab(surface, name);
  },
};
