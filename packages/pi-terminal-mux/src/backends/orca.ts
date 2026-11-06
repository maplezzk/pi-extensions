/**
 * orca.ts — Orca 终端后端（https://orca.dev，Stably 的 agent 工作台）
 *
 * Orca 是面向 agent 的桌面工作台，通过 `orca` CLI 提供 terminal 编程化控制：
 *   - `orca terminal create --title <name> --json`     新建 tab（不抢焦点）
 *   - `orca terminal split --terminal <h> --direction horizontal|vertical --json`
 *   - `orca terminal send --terminal <h> --text <text> [--enter]`
 *   - `orca terminal read --terminal <h> --limit <N> --json`
 *   - `orca terminal close --terminal <h> [--tab]`
 *   - `orca terminal rename --terminal <h> --title <name>`
 *   - `orca terminal list --json` / `orca status --json`
 *
 * 所有 JSON 响应共享信封：{ id, ok, result, _meta }。
 *   - create → result.terminal.handle
 *   - split  → result.split.handle
 *   - read   → result.terminal.tail（字符串数组，最新在尾部）
 *
 * 与其他 backend 的关键差异：
 *   1. Orca 注入 ORCA_TERMINAL_HANDLE（类似 cmux 的 CMUX_SURFACE_ID），
 *      模块加载时冻结为 AGENT_ORCA_TERMINAL_HANDLE。
 *   2. create() 与 muxy/herdr/otty 一样从 agent terminal 分屏，并通过
 *      shared.ts 的 BFS 状态机轮转 right/down；没有 agent handle 时回退为新 tab。
 *   3. Escape 通过发送裸 ESC（`\u001b`，即 `0x1b`）字节实现，TUI 会将其解释为 Escape 键。
 *   4. rename 作用于 tab 标题；split 出来的 pane 与源 pane 共享 tab，
 *      所以 createSplit 不做 rename（否则会把 agent 所在 tab 一起改名）。
 *   5. split 方向只有 horizontal|vertical。实测（Orca 1.4.174）：
 *      horizontal = 水平分割线 = 上下堆叠，vertical = 垂直分割线 = 左右并排。
 *      因此映射 left/right→vertical、up/down→horizontal。
 *
 * 日志、命令检测复用 backends/shared.ts。
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { BfsSplitStateManager, createBackendLogger, hasCommand, withFileLock } from "./shared.ts";
import type { BackendOps } from "./types.ts";

const ORCA_RUNTIME_CHECK_TIMEOUT_MS = 1_500;
const ORCA_COMMAND_TIMEOUT_MS = 10_000;

// ── 日志（统一格式，写入 /tmp/pi-mux-orca.log） ──
const orcaLog = createBackendLogger("orca", "/tmp/pi-mux-orca.log");

// ── Orca 检测 ──

/**
 * 检测 orca backend 是否可用：
 *   1. 当前进程在 Orca 终端内运行（TERM_PROGRAM=Orca）
 *   2. `orca` 命令在 PATH 中
 *   3. Orca runtime 可达（`orca status --json` 返回 ok:true，带 1.5s 超时）
 *
 * 不要求 ORCA_TERMINAL_HANDLE：create/read/send 等操作都针对显式 handle，
 * 只有 createSplit 的默认 split 源需要它（缺失时由 splitOrcaTerminal 报错）。
 */
export function isOrcaRuntimeAvailable(): boolean {
  if (process.env.TERM_PROGRAM !== "Orca") return false;
  if (!hasCommand("orca")) return false;

  // 最后一道闸：CLI 存在但 runtime 未启动时 `orca status` 会失败或 hang。
  // spawnSync timeout 兜底，避免探测卡死主流程。
  try {
    const result = spawnSync("orca", ["status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: ORCA_RUNTIME_CHECK_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return false;
    const parsed = parseOrcaJson(result.stdout ?? "");
    return parsed?.ok === true;
  } catch {
    return false;
  }
}

// ── Agent terminal handle ──

/**
 * 捕获于模块加载时的 agent terminal handle。
 * Orca 注入 ORCA_TERMINAL_HANDLE（类似 cmux 注入 CMUX_SURFACE_ID），
 * 冻结到常量，不受用户后续切换 tab 影响。
 */
export const AGENT_ORCA_TERMINAL_HANDLE: string | null = process.env.ORCA_TERMINAL_HANDLE ?? null;

// ── JSON 信封解析（纯函数，可单测） ──

/** orca CLI 的 JSON 响应信封 */
export interface OrcaEnvelope {
  ok?: boolean;
  result?: Record<string, unknown>;
}

export function parseOrcaJson(output: string): OrcaEnvelope | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as OrcaEnvelope;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch (e) {
    orcaLog(`[parse json] failed: ${(e as Error).message} raw=${JSON.stringify(trimmed.slice(0, 200))}`);
    return null;
  }
}

/** 从 `terminal create --json` 响应提取 handle：result.terminal.handle */
export function extractOrcaCreateHandle(payload: OrcaEnvelope | null): string | null {
  if (payload?.ok !== true) return null;
  const terminal = payload?.result?.["terminal"];
  if (typeof terminal !== "object" || terminal === null) return null;
  const handle = (terminal as Record<string, unknown>)["handle"];
  return typeof handle === "string" && handle ? handle : null;
}

/** 从 `terminal split --json` 响应提取新 pane handle：result.split.handle */
export function extractOrcaSplitHandle(payload: OrcaEnvelope | null): string | null {
  if (payload?.ok !== true) return null;
  const split = payload?.result?.["split"];
  if (typeof split !== "object" || split === null) return null;
  const handle = (split as Record<string, unknown>)["handle"];
  return typeof handle === "string" && handle ? handle : null;
}

/** 从 `terminal read --json` 响应提取屏幕行：result.terminal.tail（数组，最新在尾部） */
export function extractOrcaReadTail(payload: OrcaEnvelope | null): string[] {
  if (payload?.ok !== true) return [];
  const terminal = payload?.result?.["terminal"];
  if (typeof terminal !== "object" || terminal === null) return [];
  const tail = (terminal as Record<string, unknown>)["tail"];
  if (!Array.isArray(tail)) return [];
  return tail.filter((line): line is string => typeof line === "string");
}

/**
 * 统一方向 → orca split 方向。
 * 实测（Orca 1.4.174，分割线轴约定，与 iTerm 一致）：
 *   horizontal = 上下堆叠（up/down），vertical = 左右并排（left/right）。
 */
export function orcaSplitDirection(direction: "left" | "right" | "up" | "down"): "horizontal" | "vertical" {
  return direction === "left" || direction === "right" ? "vertical" : "horizontal";
}

// ── Orca BFS 分屏状态 ──

/**
 * 返回 Orca subagent 分屏状态 marker 路径。
 * 使用 agent handle 隔离不同 Orca 会话，路径放在系统临时目录中。
 */
function orcaStateFile(): string {
  const agentHandle = AGENT_ORCA_TERMINAL_HANDLE ?? "default";
  const safe = agentHandle.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${tmpdir()}/orca-subagent-pane-${safe}.json`;
}

/**
 * 从 BFS marker 中移除已关闭的 pane，避免后续 create 使用僵尸 handle。
 */
function cleanupOrcaStateForSurface(handle: string): void {
  try {
    const state = new BfsSplitStateManager(orcaStateFile());
    state.remove(handle);
  } catch (e) {
    orcaLog(`[state] cleanup failed for ${handle}: ${(e as Error).message}`);
  }
}

/**
 * 调用 `orca terminal create` 新建 tab，作为没有 agent handle 时的回退。
 */
function createOrcaTab(name: string): string {
  try {
    const raw = orcaExec(["terminal", "create", "--title", name, "--json"]);
    const handle = extractOrcaCreateHandle(parseOrcaJson(raw));
    if (!handle) {
      orcaLog(`[create] no handle in tab response for name=${JSON.stringify(name)}`);
      return "";
    }
    orcaLog(`[create] fallback=tab new=${handle} name=${JSON.stringify(name)}`);
    return handle;
  } catch (e) {
    orcaLog(`[create] fallback tab failed: ${(e as Error).message}`);
    return "";
  }
}

// ── Orca CLI 调用的薄封装 ──

/**
 * 调用 `orca` 命令并返回 stdout。
 * 失败时 stderr 写入 log，原样抛错（调用方决定如何处理）。
 */
function orcaExec(args: string[]): string {
  const cmdline = `orca ${args
    .map((a) => (a.includes(" ") || a.includes('"') ? JSON.stringify(a) : a))
    .join(" ")}`;
  orcaLog(`[exec] ${cmdline}`);
  const result = spawnSync("orca", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: ORCA_COMMAND_TIMEOUT_MS,
  });
  if (result.error) {
    orcaLog(`[exec] ERROR (spawn): ${result.error.message}`);
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    orcaLog(`[exec] ERROR status=${result.status} stderr=${JSON.stringify(stderr)}`);
    throw new Error(`orca ${args[0]} ${args[1] ?? ""} failed (status=${result.status}): ${stderr}`);
  }
  orcaLog(`[exec] -> ${JSON.stringify(result.stdout.trim().slice(0, 200))}`);
  return result.stdout;
}

/** 调用 `orca` 命令，失败只记 log 不抛错，并返回执行是否成功。 */
function orcaExecSilent(args: string[]): boolean {
  const cmdline = `orca ${args
    .map((a) => (a.includes(" ") || a.includes('"') ? JSON.stringify(a) : a))
    .join(" ")}`;
  orcaLog(`[exec silent] ${cmdline}`);
  const result = spawnSync("orca", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: ORCA_COMMAND_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    orcaLog(
      `[exec silent] ERROR status=${result.status} stderr=${JSON.stringify(
        (result.stderr ?? "").trim().slice(0, 200),
      )}`,
    );
    return false;
  }
  return true;
}

// ── 对外 API ──

/**
 * 创建一个新的 subagent terminal。
 *
 * 实现：与 muxy/herdr/otty 一致，使用持久化 BFS 状态从 agent terminal 分屏：
 *   - 第一次从 agent pane 向右分屏；
 *   - 后续按 BFS 状态机轮转 right/down，均保持 agent 焦点不变（Orca split CLI 默认不抢焦点）。
 *
 * Orca 没有注入 agent handle 时回退为新建 tab，兼容手动调用原生 API 的场景。
 * 失败返回 ""（与其他 backend create 一致，调用方统一处理）。
 */
export function createOrcaSurface(name: string): string {
  const agentHandle = AGENT_ORCA_TERMINAL_HANDLE;
  if (!agentHandle) return createOrcaTab(name);

  const markerFile = orcaStateFile();
  const lockPath = `${markerFile}.lock`;

  try {
    return withFileLock(lockPath, { timeoutMs: 3_000 }, () => {
      let state = new BfsSplitStateManager(markerFile);

      // 首次 split：从 agent pane 向右分屏。
      if (state.panes().length === 0) {
        const newHandle = splitOrcaTerminal("right", agentHandle);
        if (!newHandle) {
          orcaLog(`[create] first split failed from=${agentHandle}`);
          return "";
        }
        state.add(newHandle);
        orcaLog(`[create] mode=first dir=right from=${agentHandle} new=${newHandle} name=${JSON.stringify(name)}`);
        return newHandle;
      }

      const next = state.next();
      if (!next) return "";

      // 正常路径按 BFS 状态机分屏；目标 pane 失效时清空状态并从 agent pane 恢复。
      let newHandle = splitOrcaTerminal(next.direction, next.source);
      if (newHandle) {
        state.advance();
        state.add(newHandle);
        orcaLog(
          `[create] mode=next dir=${next.direction} from=${next.source} new=${newHandle} name=${JSON.stringify(name)}`,
        );
        return newHandle;
      }

      orcaLog(`[create] pane ${next.source} unavailable, reset and retry from agent pane`);
      for (const pane of state.panes()) state.remove(pane);
      state = new BfsSplitStateManager(markerFile);
      newHandle = splitOrcaTerminal("right", agentHandle);
      if (!newHandle) {
        orcaLog(`[create] reset split failed from=${agentHandle}`);
        return "";
      }
      state.add(newHandle);
      orcaLog(`[create] mode=recovered dir=right from=${agentHandle} new=${newHandle} name=${JSON.stringify(name)}`);
      return newHandle;
    });
  } catch (e) {
    orcaLog(`[create] failed: ${(e as Error).message}`);
    return "";
  }
}

/**
 * 指定方向分屏创建新 pane。
 * fromSurface 缺省时从 agent 自己的 terminal（ORCA_TERMINAL_HANDLE）拆。
 * 失败返回 ""。
 */
export function splitOrcaTerminal(
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const source = fromSurface ?? AGENT_ORCA_TERMINAL_HANDLE;
  if (!source) {
    orcaLog(`[split] no source terminal (ORCA_TERMINAL_HANDLE not set)`);
    return "";
  }
  const orcaDir = orcaSplitDirection(direction);
  try {
    const raw = orcaExec(["terminal", "split", "--terminal", source, "--direction", orcaDir, "--json"]);
    const handle = extractOrcaSplitHandle(parseOrcaJson(raw));
    if (!handle) {
      orcaLog(`[split] no handle in response (from=${source} dir=${orcaDir})`);
      return "";
    }
    orcaLog(`[split] from=${source} dir=${orcaDir} new=${handle}`);
    return handle;
  } catch (e) {
    orcaLog(`[split] from=${source} dir=${orcaDir} failed: ${(e as Error).message}`);
    return "";
  }
}

/**
 * 给 terminal 发送命令 + Enter。
 * `orca terminal send --text <cmd> --enter`，失败只记 log（best-effort）。
 */
export function sendOrcaCommand(handle: string, command: string): void {
  orcaExecSilent(["terminal", "send", "--terminal", handle, "--text", command, "--enter"]);
}

/**
 * 给 terminal 发送 Escape。
 * 实现：发送裸 ESC（`\u001b`，即 `0x1b`）字节，TUI 会将其解释为 Escape 键。
 * 注意不能用 --enter（会把 ESC 和回车拼成一行输入）。
 */
export function sendOrcaEscape(handle: string): void {
  orcaExecSilent(["terminal", "send", "--terminal", handle, "--text", "\u001b"]);
}

/**
 * 读取 terminal 屏幕最后 N 行。
 * `orca terminal read --limit <N> --json` → result.terminal.tail，拼成文本返回。
 * 失败返回 ""（与 otty readScreen 一致）。
 */
export function readOrcaScreen(handle: string, lines = 50): string {
  try {
    const raw = orcaExec(["terminal", "read", "--terminal", handle, "--limit", String(lines), "--json"]);
    return extractOrcaReadTail(parseOrcaJson(raw)).join("\n");
  } catch (e) {
    orcaLog(`[read] terminal=${handle} failed: ${(e as Error).message}`);
    return "";
  }
}

/**
 * 目标 terminal 的状态（三态，供关闭流程判定）。
 * present 附带所在 tab 的占用情况：tabCount = 同一 tabId 下的 terminal 数量（tabId 缺失时为 null）。
 */
export type OrcaTerminalState =
  | { kind: "absent" }
  | { kind: "present"; tabId: string | null; tabCount: number | null }
  | { kind: "unknown" };

/** 关闭 pane 的下一步动作。 */
export type OrcaCloseDecision = "done" | "retry-close" | "close-tab" | "skip-tab";

/**
 * 解析 `terminal list --json`，得到 handle 的状态与所在 tab 的 terminal 数量。
 * 纯函数便于单测；列表结构异常时返回 unknown（不可判定，不能当作“已关闭”）。
 */
export function parseOrcaTerminalTabInfo(raw: string, handle: string): OrcaTerminalState {
  const parsed = parseOrcaJson(raw);
  const terminals = parsed?.result?.["terminals"];
  if (!Array.isArray(terminals)) return { kind: "unknown" };

  const entries = terminals.filter(
    (t): t is Record<string, unknown> => typeof t === "object" && t !== null,
  );
  const self = entries.find((t) => t["handle"] === handle);
  if (!self) return { kind: "absent" };

  const tabId = typeof self["tabId"] === "string" ? self["tabId"] : null;
  const tabCount = tabId === null ? null : entries.filter((t) => t["tabId"] === tabId).length;
  return { kind: "present", tabId, tabCount };
}

/**
 * 判定关闭 pane 的下一步动作。
 *
 * 关键约束：split 出来的子 pane 与源 pane（可能是 agent 自己的会话）共享同一个 tab，
 * 而 `--tab` 会关掉整个 tab —— 所以只有确认 tab 内只有自己时才允许升级到 `--tab`。
 * unknown（list 查询失败/结构异常）不可判定，同样不升级：宁可留下残留 pane，
 * 也不能连带杀掉同 tab 的其它会话。
 */
export function decideOrcaCloseStep(params: {
  state: OrcaTerminalState;
  targetIsAgentPane: boolean;
  retried: boolean;
}): OrcaCloseDecision {
  const { state, targetIsAgentPane, retried } = params;
  if (state.kind === "absent") return "done";
  if (state.kind === "unknown") return "skip-tab";
  if (targetIsAgentPane) return "skip-tab";
  if (!retried) return "retry-close";
  return state.tabCount === 1 ? "close-tab" : "skip-tab";
}

/** 查询 terminal 状态；查询失败/响应异常统一归一为 unknown。 */
function queryOrcaTerminalState(handle: string): OrcaTerminalState {
  try {
    return parseOrcaTerminalTabInfo(orcaExec(["terminal", "list", "--json"]), handle);
  } catch {
    return { kind: "unknown" };
  }
}

/**
 * 关闭 terminal。
 *
 * create() 与 createSplit() 产物可能与其他 pane 共享 tab，因此必须区分「关 pane」和「关 tab」：
 *   1. `terminal close`（只关这个 pane）
 *   2. 校验 list：仍在则再 `terminal close` 一次后复查 —— close 生效与子进程真正退出之间存在
 *      竞态，首次校验的“仍在”多为误判。
 *   3. 仍存在时，仅当同一 tab 内只有这一个 terminal（tabCount===1）且目标不是 agent pane，
 *      才补 `terminal close --tab`（单 pane tab 的残留情况）；共享 tab 一律不关 tab，否则会
 *      连带关掉同 tab 的其它会话。
 *   4. list 查询失败（unknown）视为不可判定，不升级为关 tab，只记 warn。
 *   5. 清理 BFS marker；失败仅 log warn，绝不 throw（避免打断 pollForExit 退出流程）。
 */
export function closeOrcaSurface(handle: string): void {
  const targetIsAgentPane = handle === AGENT_ORCA_TERMINAL_HANDLE;
  try {
    orcaExecSilent(["terminal", "close", "--terminal", handle, "--json"]);
    let state = queryOrcaTerminalState(handle);

    if (decideOrcaCloseStep({ state, targetIsAgentPane, retried: false }) === "retry-close") {
      orcaExecSilent(["terminal", "close", "--terminal", handle, "--json"]);
      state = queryOrcaTerminalState(handle);
    }

    switch (decideOrcaCloseStep({ state, targetIsAgentPane, retried: true })) {
      case "done":
        orcaLog(`[close] terminal ${handle} closed`);
        return;
      case "close-tab": {
        const tabId = state.kind === "present" ? state.tabId : null;
        orcaLog(`[close] terminal ${handle} sole occupant of tab ${tabId}, trying --tab`);
        orcaExecSilent(["terminal", "close", "--terminal", handle, "--tab", "--json"]);
        if (queryOrcaTerminalState(handle).kind === "absent") {
          orcaLog(`[close] terminal ${handle} closed via --tab`);
        } else {
          orcaLog(`[close] WARN terminal ${handle} still present after close --tab`);
        }
        return;
      }
      default:
        // skip-tab：绝不关整个 tab，只记录原因（残留 pane 交给用户手动关）。
        if (state.kind === "unknown") {
          orcaLog(`[close] WARN terminal ${handle} list query failed/unusable, skip --tab (unverifiable)`);
        } else if (targetIsAgentPane) {
          orcaLog(`[close] WARN terminal ${handle} is the agent pane itself, skip --tab`);
        } else if (state.kind === "present") {
          orcaLog(
            `[close] WARN terminal ${handle} shares tab ${state.tabId} with ${(state.tabCount ?? 0) - 1} sibling terminal(s), skip --tab to protect them`,
          );
        }
        return;
    }
  } finally {
    cleanupOrcaStateForSurface(handle);
  }
}

/**
 * 重命名 terminal 所在 tab。
 * 注意：rename 作用于 tab 标题，split pane 与源 pane 共享 tab ——
 * 调用方需确认 target 是独立 tab（create() 产物或 agent 自己的 terminal）。
 */
export function renameOrcaTerminal(handle: string, name: string): boolean {
  return orcaExecSilent(["terminal", "rename", "--terminal", handle, "--title", name]);
}

// ── BackendOps 适配器（薄包装以上原生函数，行为语义见各函数注释） ──

/** BackendOps 适配器：所有方法薄包装 orca 原生函数 */
export const ops: BackendOps = {
  /** 创建 orca surface（从 agent terminal BFS 分屏；无 handle 时回退新 tab） */
  create(name: string): string {
    return createOrcaSurface(name);
  },
  /** 指定方向分屏；不做 rename（split pane 与源 pane 共享 tab 标题） */
  createSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
    return splitOrcaTerminal(direction, fromSurface);
  },
  /** 向 orca terminal 发送命令并执行 */
  send(surface: string, command: string): void {
    sendOrcaCommand(surface, command);
  },
  /** 向 orca terminal 发送 Escape（裸 ESC 字节） */
  sendEscape(surface: string): void {
    sendOrcaEscape(surface);
  },
  /** 同步读取 orca terminal 屏幕最后 N 行 */
  read(surface: string, lines = 50): string {
    return readOrcaScreen(surface, lines);
  },
  /** 异步读取 orca terminal 屏幕最后 N 行 */
  async readAsync(surface: string, lines = 50): Promise<string> {
    return readOrcaScreen(surface, lines);
  },
  /** 关闭 orca terminal（best-effort：close → close --tab → log warn） */
  close(surface: string): void {
    closeOrcaSurface(surface);
  },
  /** 重命名 orca terminal 所在 tab */
  rename(surface: string, name: string): void {
    renameOrcaTerminal(surface, name);
  },
};
