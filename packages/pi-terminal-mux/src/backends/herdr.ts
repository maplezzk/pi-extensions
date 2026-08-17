/**
 * herdr.ts — herdr multiplexer backend for pi-interactive-subagents
 *
 * herdr 是一个终端原生 agent multiplexer（参见 https://herdr.dev）。
 * 当 pi 在 herdr 管理的 pane 内运行时，herdr 会注入：
 *   HERDR_ENV=1
 *   HERDR_WORKSPACE_ID（公开 id，如 "1"）
 *   HERDR_TAB_ID（公开 id，如 "1:1"）
 *   HERDR_PANE_ID（公开 id，如 "1-1"）
 *
 * 所有 tab / pane 操作通过 `herdr` CLI 完成，详见 SKILL.md。
 * 日志、文件锁、BFS 分屏状态机、命令检测复用 backends/shared.ts。
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { i18n } from "../i18n.ts";
import { createBackendLogger, withFileLock, BfsSplitStateManager, hasCommand } from "./shared.ts";

// ── 日志（统一格式，写入 /tmp/pi-mux-herdr.log） ──
const herdrLog = createBackendLogger("herdr", "/tmp/pi-mux-herdr.log");
const HERDR_TAB_CLOSE_COMMAND = ["tab", "close"] as const;
const HERDR_PANE_SPLIT_COMMAND = ["pane", "split"] as const;
const HERDR_PANE_CLOSE_COMMAND = ["pane", "close"] as const;
const HERDR_SPLIT_DIRECTION_FLAG = "--direction";
const HERDR_NO_FOCUS_FLAG = "--no-focus";
const HERDR_SPLIT_RIGHT = "right";
const HERDR_SPLIT_DOWN = "down";
const HERDR_SPLIT_UP = "up";
const HERDR_MARKER_PATH_PREFIX = "/tmp/herdr-subagent-pane-";
const HERDR_MARKER_DEFAULT_ID = "default";
const HERDR_LOCK_SUFFIX = ".lock";
export const HERDR_SURFACE_MODE_SPLIT = "split";
export const HERDR_SURFACE_MODE_TAB = "tab";
const DEFAULT_HERDR_SURFACE_MODE = HERDR_SURFACE_MODE_SPLIT;

export type HerdrSurfaceMode =
  | typeof HERDR_SURFACE_MODE_SPLIT
  | typeof HERDR_SURFACE_MODE_TAB;

/** 解析 Herdr surface 放置模式；未配置时保持旧版 split，非法显式值直接报错。 */
export function resolveHerdrSurfaceMode(value = process.env.PI_SUBAGENT_HERDR_MODE): HerdrSurfaceMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === HERDR_SURFACE_MODE_SPLIT) return DEFAULT_HERDR_SURFACE_MODE;
  if (normalized === HERDR_SURFACE_MODE_TAB) return HERDR_SURFACE_MODE_TAB;
  throw new Error(i18n.t("error.invalidHerdrMode", { value }));
}

/**
 * 捕获于模块加载时的 agent pane id。
 * herdr 在启动 pane 的子进程时注入 HERDR_PANE_ID（公开 id 格式，如 "1-1"）。
 * 模块加载后再读取 env 可能反映用户切换焦点后的值，所以冻结到常量。
 */
export const AGENT_HERDR_PANE_ID = process.env.HERDR_PANE_ID;
export const AGENT_HERDR_WORKSPACE_ID = process.env.HERDR_WORKSPACE_ID;
export const AGENT_HERDR_TAB_ID = process.env.HERDR_TAB_ID;

/**
 * 检测 herdr backend 是否可用：
 *   1. `herdr` 命令在 PATH 中
 *   2. 当前进程在 herdr pane 内运行（HERDR_ENV=1）
 *   3. HERDR_PANE_ID 已注入；tab 模式还要求 HERDR_WORKSPACE_ID
 *
 * 注意：即使 socket 暂时不通，只要命令存在且 env 注入，就认为"runtime available"。
 * 子 agent 创建时再通过对应的 pane split / tab create 命令触发 socket 调用。
 */
export function isHerdrRuntimeAvailable(): boolean {
  if (
    process.env.HERDR_ENV !== "1" ||
    !process.env.HERDR_PANE_ID ||
    !hasCommand("herdr")
  ) {
    return false;
  }
  return resolveHerdrSurfaceMode() === HERDR_SURFACE_MODE_SPLIT || !!process.env.HERDR_WORKSPACE_ID;
}

// ── herdr CLI 调用的薄封装 ──

/**
 * 调用 `herdr` 命令并返回 stdout。
 * 失败时原样抛错（调用方决定如何处理）。
 */
function herdrExec(args: string[]): string {
  herdrLog(`[exec] herdr ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
  const out = execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  herdrLog(`[exec] -> ${JSON.stringify(out.trim().slice(0, 200))}`);
  return out;
}

/**
 * 调用 `herdr` 命令，丢弃 stdout。用于 sendCommand / sendKeys / closePane 这类
 * 无输出的命令，遵循 SKILL.md 中"pane send-text/send-keys/run print nothing on success"。
 */
function herdrExecSilent(args: string[]): void {
  herdrLog(`[exec silent] herdr ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
  execFileSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * 解析 herdr JSON 输出，失败返回 null。
 * SKILL.md 说明：`workspace list`、`tab create`、`pane split` 等成功命令打印 JSON。
 */
function parseHerdrJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * 从 herdr JSON 响应中提取 pane 的公开 id。
 * pane split 响应格式：`{ "id": "...", "result": { "type": "pane_info", "pane": { "pane_id": "1-2", ... } } }`
 */
function extractPaneId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const result = obj.result;
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // 多种结果类型都包含 pane：pane_info、pane_created 等
  const pane = (r.pane ?? r.root_pane) as Record<string, unknown> | undefined;
  if (pane && typeof pane.pane_id === "string") return pane.pane_id;
  return null;
}

// ── BFS 分屏状态 marker 路径 ──

/** herdr BFS 分屏状态 marker 文件路径（按 agent pane id 区分） */
function herdrMarkerPath(): string {
  const paneId = (AGENT_HERDR_PANE_ID ?? HERDR_MARKER_DEFAULT_ID).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${HERDR_MARKER_PATH_PREFIX}${paneId}.json`;
}

interface CreatedHerdrTab {
  tabId: string;
  paneId: string;
}

/** 从 `herdr tab create` 响应提取新 tab 与 root pane 的公开 id。 */
function extractCreatedHerdrTab(json: unknown): CreatedHerdrTab | null {
  if (!json || typeof json !== "object") return null;
  const result = (json as Record<string, unknown>).result;
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const tab = record.tab as Record<string, unknown> | undefined;
  const rootPane = record.root_pane as Record<string, unknown> | undefined;
  if (typeof tab?.tab_id !== "string" || typeof rootPane?.pane_id !== "string") return null;
  return { tabId: tab.tab_id, paneId: rootPane.pane_id };
}

/** 记录由本进程创建的 tab surface，使 rename / close 操作作用于整个 tab。 */
const createdHerdrTabIds = new Map<string, string>();

// ── 对外 API：createSurface 系列 ──

/** 使用原有 BFS 策略创建 subagent 分屏。 */
function createHerdrSplitSurface(name: string): string {
  if (!AGENT_HERDR_PANE_ID) {
    throw new Error(
      "HERDR_PANE_ID not set; cannot determine parent pane for subagent split. " +
        "Start pi inside herdr so HERDR_PANE_ID is injected at launch.",
    );
  }

  const markerFile = herdrMarkerPath();
  const lockPath = `${markerFile}${HERDR_LOCK_SUFFIX}`;

  return withFileLock(lockPath, {}, () => {
    const state = new BfsSplitStateManager(markerFile);

    if (state.panes().length === 0) {
      const output = herdrExec([
        ...HERDR_PANE_SPLIT_COMMAND,
        AGENT_HERDR_PANE_ID,
        HERDR_SPLIT_DIRECTION_FLAG,
        HERDR_SPLIT_RIGHT,
        HERDR_NO_FOCUS_FLAG,
      ]);
      const newPaneId = extractPaneId(parseHerdrJson(output));
      if (newPaneId) {
        state.add(newPaneId);
        renameHerdrPane(newPaneId, name);
        herdrLog(
          `[split] mode=first dir=right from=${AGENT_HERDR_PANE_ID} new=${newPaneId} name=${JSON.stringify(name)}`,
        );
        return newPaneId;
      }
      herdrLog(`[split] first split returned no pane id, output=${JSON.stringify(output)}`);
      return "";
    }

    const next = state.next();
    if (!next) return "";

    let { source } = next;
    const { direction } = next;
    let output: string;
    try {
      output = herdrExec([
        ...HERDR_PANE_SPLIT_COMMAND,
        source,
        HERDR_SPLIT_DIRECTION_FLAG,
        direction,
        HERDR_NO_FOCUS_FLAG,
      ]);
    } catch {
      try { rmSync(markerFile); } catch { /* ignore */ }
      herdrLog(`[split] pane ${source} gone, resetting from agent pane ${AGENT_HERDR_PANE_ID}`);
      source = AGENT_HERDR_PANE_ID;
      output = herdrExec([
        ...HERDR_PANE_SPLIT_COMMAND,
        source,
        HERDR_SPLIT_DIRECTION_FLAG,
        HERDR_SPLIT_RIGHT,
        HERDR_NO_FOCUS_FLAG,
      ]);
    }

    const newPaneId = extractPaneId(parseHerdrJson(output));
    if (newPaneId) {
      state.advance();
      state.add(newPaneId);
      renameHerdrPane(newPaneId, name);
      herdrLog(
        `[split] mode=next dir=${direction} from=${source} new=${newPaneId} name=${JSON.stringify(name)}`,
      );
      return newPaneId;
    }
    herdrLog(`[split] next split returned no pane id, output=${JSON.stringify(output)}`);
    return "";
  });
}

/** 在当前 workspace 中创建独立后台 tab，并返回 root pane id。 */
function createHerdrTabSurface(name: string): string {
  if (!AGENT_HERDR_WORKSPACE_ID) {
    throw new Error(
      "HERDR_WORKSPACE_ID not set; cannot determine workspace for subagent tab. " +
        "Start pi inside herdr so HERDR_WORKSPACE_ID is injected at launch.",
    );
  }

  const tabLabel = herdrSurfaceLabel(name);
  const output = herdrExec([
    "tab",
    "create",
    "--workspace",
    AGENT_HERDR_WORKSPACE_ID,
    "--cwd",
    process.cwd(),
    "--label",
    tabLabel,
    "--no-focus",
  ]);
  const createdTab = extractCreatedHerdrTab(parseHerdrJson(output));
  if (!createdTab) {
    throw new Error(`Unexpected herdr tab create output: ${output.trim() || "(empty)"}`);
  }

  createdHerdrTabIds.set(createdTab.paneId, createdTab.tabId);
  herdrLog(
    `[tab create] workspace=${AGENT_HERDR_WORKSPACE_ID} tab=${createdTab.tabId} pane=${createdTab.paneId} name=${JSON.stringify(name)}`,
  );
  return createdTab.paneId;
}

/** 按 PI_SUBAGENT_HERDR_MODE 选择兼容分屏或独立 tab；默认保持 split。 */
export function createHerdrSurface(name: string): string {
  return resolveHerdrSurfaceMode() === HERDR_SURFACE_MODE_TAB
    ? createHerdrTabSurface(name)
    : createHerdrSplitSurface(name);
}

/**
 * 从指定 pane 直接分屏（不走广度优先状态机），供 createSurfaceSplit 使用。
 * herdr 文档仅明确 right/down，left/up 分别归一到 right/down。
 * 返回新 pane 的公开 id；识别失败时抛错。
 */
export function splitHerdrPane(
  fromPane: string,
  direction: "left" | "right" | "up" | "down",
  name?: string,
): string {
  const dir = direction === HERDR_SPLIT_DOWN || direction === HERDR_SPLIT_UP
    ? HERDR_SPLIT_DOWN
    : HERDR_SPLIT_RIGHT;
  const output = herdrExec([
    ...HERDR_PANE_SPLIT_COMMAND,
    fromPane,
    HERDR_SPLIT_DIRECTION_FLAG,
    dir,
    HERDR_NO_FOCUS_FLAG,
  ]);
  const newPaneId = extractPaneId(parseHerdrJson(output));
  if (!newPaneId) {
    throw new Error(`Unexpected herdr pane split output: ${output.trim() || "(empty)"}`);
  }
  if (name) renameHerdrPane(newPaneId, name);
  herdrLog(`[split] mode=direct dir=${dir} from=${fromPane} new=${newPaneId} name=${JSON.stringify(name ?? "")}`);
  return newPaneId;
}

/**
 * 用 herdr CLI 重命名 pane 的 label（pane 名称）。
 * 格式: workspace_label[name]
 */
export function renameHerdrPane(paneId: string, name: string): void {
  try {
    const wsLabel = getWorkspaceLabel();
    const paneLabel = wsLabel ? `${wsLabel}[${name}]` : name;
    herdrExecSilent(["pane", "rename", paneId, paneLabel]);
  } catch (e) {
    herdrLog(`[rename pane] pane=${paneId} name=${JSON.stringify(name)} failed: ${(e as Error).message}`);
  }
}

/**
 * 用 herdr CLI 重命名 agent 标题（左侧侧栏显示的名字）。
 * 需要在 pi 启动并被 herdr 检测到 agent 后才能生效。
 * 若 agent 尚未检测到则静默失败。
 */
export function renameHerdrAgent(paneId: string, name: string): void {
  try {
    herdrExecSilent(["agent", "rename", paneId, name]);
  } catch (e) {
    herdrLog(`[rename agent] pane=${paneId} name=${JSON.stringify(name)} failed: ${(e as Error).message}`);
  }
}

/**
 * 获取当前 workspace 的 label。
 */
function getWorkspaceLabel(): string | null {
  if (!AGENT_HERDR_WORKSPACE_ID) return null;
  try {
    const output = herdrExec(["workspace", "get", AGENT_HERDR_WORKSPACE_ID]);
    const parsed = parseHerdrJson(output);
    if (!parsed || typeof parsed !== "object") return null;
    const result = (parsed as Record<string, unknown>).result as Record<string, unknown> | undefined;
    const workspace = result?.workspace as Record<string, unknown> | undefined;
    return (workspace?.label as string) ?? null;
  } catch {
    return null;
  }
}

/** 生成 herdr pane / tab 的统一显示标签。 */
function herdrSurfaceLabel(name: string): string {
  const workspaceLabel = getWorkspaceLabel();
  return workspaceLabel ? `${workspaceLabel}[${name}]` : name;
}

/**
 * 用 herdr CLI 重命名 pane 对应的 tab。
 * tab label 格式: workspace_label[name]
 */
export function renameHerdrTab(paneId: string, name: string): void {
  const ws = parseWorkspaceIdFromPaneId(paneId);
  if (!ws) return;
  try {
    const tabLabel = herdrSurfaceLabel(name);
    const tabsJson = herdrExec(["tab", "list", "--workspace", ws]);
    const parsed = parseHerdrJson(tabsJson);
    if (!parsed || typeof parsed !== "object") return;
    const result = (parsed as Record<string, unknown>).result as Record<string, unknown> | undefined;
    const tabs = (result?.tabs as Array<Record<string, unknown>>) ?? [];
    if (tabs.length > 0) {
      const firstTab = tabs[0];
      if (firstTab && typeof firstTab.tab_id === "string") {
        herdrExecSilent(["tab", "rename", firstTab.tab_id, tabLabel]);
      }
    }
  } catch (e) {
    herdrLog(`[rename tab] pane=${paneId} name=${JSON.stringify(name)} failed: ${(e as Error).message}`);
  }
}

/**
 * 重命名 workspace。herdr 中 workspace rename 命令是 `herdr workspace rename <id> <label>`。
 * 仅当环境变量 PI_SUBAGENT_RENAME_HERDR_WORKSPACE=1 时启用（保守策略，避免影响用户命名）。
 */
export function renameHerdrWorkspace(title: string): void {
  if (process.env.PI_SUBAGENT_RENAME_HERDR_WORKSPACE !== "1") return;
  if (!AGENT_HERDR_WORKSPACE_ID) return;
  try {
    herdrExecSilent(["workspace", "rename", AGENT_HERDR_WORKSPACE_ID, title]);
  } catch (e) {
    herdrLog(`[rename workspace] title=${JSON.stringify(title)} failed: ${(e as Error).message}`);
  }
}

// ── 对外 API：pane 操作 ──

/**
 * 给 pane 发送命令 + Enter。
 * 使用 `herdr pane run <id> <cmd>` 一条命令搞定（SKILL.md 保证会发真实 Enter）。
 */
export function sendHerdrCommand(paneId: string, command: string): void {
  herdrExecSilent(["pane", "run", paneId, command]);
}

/**
 * 给 pane 发送 Escape。
 * `herdr pane send-keys <id> Escape`（SKILL.md 中 send-keys 接受 "Escape" 这种 key name）。
 */
export function sendHerdrEscape(paneId: string): void {
  herdrExecSilent(["pane", "send-keys", paneId, "Escape"]);
}

/**
 * 将 herdr source 归一化为 CLI 使用的标志值（recent_unwrapped -> recent-unwrapped，其余原样）。
 */
export function herdrSourceFlag(source: "visible" | "recent" | "recent_unwrapped"): string {
  return source === "recent_unwrapped" ? "recent-unwrapped" : source;
}

/**
 * 读取 pane 屏幕内容。
 * SKILL.md：`herdr pane read <id> --source <src> --lines N` 直接打印文本（非 JSON）。
 *
 * 默认 source 用 `visible`，与其他 backend (cmux / wezterm) 的 readScreen 语义一致：
 * 读当前 viewport，新 pane 没 scrollback 时不会返回空。
 *
 * wait output 机制如果需要 recent_unwrapped 语义，请另行包装 — 这里只服务 subagent
 * 状态检测和实时读屏，不需要 soft-wrap 合并。
 */
export function readHerdrScreen(paneId: string, lines = 50, source: "visible" | "recent" | "recent_unwrapped" = "visible"): string {
  // SKILL.md 列出的 source 选项
  return herdrExec(["pane", "read", paneId, "--source", herdrSourceFlag(source), "--lines", String(lines)]);
}

/**
 * 关闭 surface。本进程创建的 tab surface 关闭整个 tab；其他 pane id 仍按 pane 关闭。
 */
export function closeHerdrSurface(paneId: string): void {
  const tabId = createdHerdrTabIds.get(paneId);
  if (tabId) {
    herdrExecSilent([...HERDR_TAB_CLOSE_COMMAND, tabId]);
    createdHerdrTabIds.delete(paneId);
    herdrLog(`[close] tab=${tabId} pane=${paneId}`);
    return;
  }

  herdrExecSilent([...HERDR_PANE_CLOSE_COMMAND, paneId]);

  const state = new BfsSplitStateManager(herdrMarkerPath());
  const beforePanes = state.panes();
  state.remove(paneId);
  const afterPanes = state.panes();
  if (beforePanes.length !== afterPanes.length) {
    herdrLog(`[close] pane=${paneId} panes=${JSON.stringify(beforePanes)} -> ${JSON.stringify(afterPanes)}`);
  } else {
    herdrLog(`[close] pane=${paneId} (not in marker state.panes)`);
  }
}

// ── 辅助：从 pane id 解析 workspace id ──
//
// herdr 公开 id 格式：
//   workspace: "1", "2" 或 "wA"
//   tab:      "1:1", "wA:t1"
//   pane:     "1-1", "wA-3", "wA:p3"
//
// pane id 的 workspace 段总是位于 "-" 或 ":p" 之前。
function parseWorkspaceIdFromPaneId(paneId: string): string | null {
  // "1-1" -> "1", "wA-3" -> "wA", "wA:p3" -> "wA"
  const dashMatch = paneId.match(/^([^-:]+)-/);
  if (dashMatch) return dashMatch[1] ?? null;
  const colonMatch = paneId.match(/^([^:]+):p/);
  if (colonMatch) return colonMatch[1] ?? null;
  return null;
}

// ── 与 mux 检测 / setup hint 的集成辅助 ──

/**
 * herdr setup hint —— 用户没在 herdr pane 内时提示。
 */
export function herdrSetupHint(preferred: boolean): string {
  if (preferred) {
    return i18n.t("setupHint.herdrPreferred");
  }
  return "";
}

// ── BackendOps 适配器（薄包装现有原生函数，行为语义见各函数注释） ──

import type { BackendOps } from "./types.ts";

/** BackendOps 适配器：所有方法薄包装 herdr 原生函数 */
export const ops: BackendOps = {
  /** 创建 herdr surface */
  create(name: string): string {
    return createHerdrSurface(name);
  },
  createSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return splitHerdrPane(fromSurface ?? AGENT_HERDR_PANE_ID ?? "", direction, name);
  },
  send(surface: string, command: string): void {
    sendHerdrCommand(surface, command);
  },
  sendEscape(surface: string): void {
    sendHerdrEscape(surface);
  },
  read(surface: string, lines = 50): string {
    return readHerdrScreen(surface, lines, "recent");
  },
  async readAsync(surface: string, lines = 50): Promise<string> {
    return readHerdrScreen(surface, lines, "recent");
  },
  close(surface: string): void {
    closeHerdrSurface(surface);
  },
  rename(surface: string, name: string): void {
    const tabId = createdHerdrTabIds.get(surface);
    if (!tabId) {
      renameHerdrPane(surface, name);
      return;
    }
    try {
      const tabLabel = herdrSurfaceLabel(name);
      herdrExecSilent(["tab", "rename", tabId, tabLabel]);
    } catch (error) {
      herdrLog(
        `[rename tab] tab=${tabId} pane=${surface} name=${JSON.stringify(name)} failed: ${(error as Error).message}`,
      );
    }
  },
};
