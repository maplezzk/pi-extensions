import { execFileSync } from "node:child_process";
import { getMuxBackend, type MuxBackend } from "./detection.ts";
import { type RenameOperation, type RenameTarget } from "./surface.ts";
import { getCreatedHerdrTabId } from "./backends/herdr.ts";
import { AGENT_OTTY_PANE_ID, getTabIdForPane } from "./backends/otty.ts";
import { renameOrcaTerminal } from "./backends/orca.ts";
import { i18n } from "./i18n.ts";

export const TERMINAL_RENAME_CONTEXT_ENV = "PI_TERMINAL_RENAME_CONTEXT";
const CONTEXT_VERSION = 1;
const COMMAND_TIMEOUT_MS = 5_000;
const RENAME_COMMANDS = {
  cmuxTab: ["rename-tab", "--surface"],
  cmuxWorkspace: ["workspace-action", "--workspace"],
  cmuxWorkspaceAction: ["--action", "rename", "--title"],
  muxy: ["rename-pane", "--pane"],
  tmuxTab: ["rename-window", "-t"],
  tmuxWorkspace: ["rename-session", "-t"],
  tmuxLookup: ["display-message", "-p", "-t"],
  tmuxWindowId: "#{window_id}",
  tmuxSessionId: "#{session_id}",
  zellij: ["action", "rename-pane"],
  paneId: "--pane-id",
  weztermTab: ["cli", "set-tab-title", "--pane-id"],
  weztermWorkspace: ["cli", "set-window-title", "--pane-id"],
  herdr: "rename",
  otty: ["tab", "rename", "--tab"],
} as const;
const BACKENDS = ["cmux", "muxy", "tmux", "zellij", "wezterm", "herdr", "otty", "orca"] as const;

export interface TerminalRenameTarget {
  backend: MuxBackend;
  operation: RenameOperation;
  target: RenameTarget;
  id: string;
  scope: "surface" | "shared";
}

/** 启动方授予的单个 surface 改名范围；不是操作系统安全边界。 */
export interface SurfaceRenameContext {
  version: 1;
  backend: MuxBackend | null;
  surface: string;
  ownedTarget: { target: "pane" | "tab" | "terminal"; id: string } | null;
}

export type TerminalRenameOutcome =
  | { status: "ready" | "renamed"; reference: TerminalRenameTarget }
  | { status: "skipped"; operation: RenameOperation; reason: "unsupported" | "disabled" | "shared" | "unverified" | "missing-id"; setting?: string }
  | { status: "failed"; operation: RenameOperation; error: string };

/** 只把可确认独占的 surface 授给子进程，绝不把 pane 扩大为共享窗口。 */
export function createSurfaceRenameContext(surface: string, backend = getMuxBackend()): SurfaceRenameContext {
  let ownedTarget: SurfaceRenameContext["ownedTarget"] = null;
  if (surface.startsWith("headless:")) backend = null;
  if (surface) {
    if (backend === "cmux") ownedTarget = { target: "tab", id: surface };
    if (backend === "muxy" || backend === "zellij") ownedTarget = { target: "pane", id: surface };
    if (backend === "herdr") {
      const tabId = getCreatedHerdrTabId(surface);
      ownedTarget = tabId ? { target: "tab", id: tabId } : { target: "pane", id: surface };
    }
  }
  return { version: CONTEXT_VERSION, backend, surface, ownedTarget };
}

/** 校验跨进程协议；损坏或未知版本不退回主会话权限。 */
export function readSurfaceRenameContext(env: NodeJS.ProcessEnv = process.env): SurfaceRenameContext | undefined {
  const raw = env[TERMINAL_RENAME_CONTEXT_ENV];
  if (raw === undefined) {
    // 旧启动方没有归属信息时，只读其身份标志以收紧范围，不能猜测独占 tab。
    if (env.PI_SUBAGENT_ID || env.PI_SUBAGENT_SURFACE) {
      return { version: CONTEXT_VERSION, backend: null, surface: "", ownedTarget: null };
    }
    return undefined;
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(i18n.t("rename.invalidContext")); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(i18n.t("rename.invalidContext"));
  const context = value as Record<string, unknown>;
  const validBackend = context.backend === null || BACKENDS.some((backend) => backend === context.backend);
  if (context.version !== CONTEXT_VERSION || !validBackend || typeof context.surface !== "string" ||
      Object.keys(context).some((key) => !["version", "backend", "surface", "ownedTarget"].includes(key))) {
    throw new Error(i18n.t("rename.invalidContext"));
  }
  if (context.ownedTarget !== null) {
    if (!context.ownedTarget || typeof context.ownedTarget !== "object" || Array.isArray(context.ownedTarget)) {
      throw new Error(i18n.t("rename.invalidContext"));
    }
    const owned = context.ownedTarget as Record<string, unknown>;
    const targetByBackend: Partial<Record<MuxBackend, readonly string[]>> = {
      cmux: ["tab"], muxy: ["pane"], zellij: ["pane"], herdr: ["pane", "tab"],
    };
    if (!context.surface || typeof owned.id !== "string" || !owned.id.trim() ||
        Object.keys(owned).some((key) => !["target", "id"].includes(key)) ||
        !targetByBackend[context.backend as MuxBackend]?.includes(owned.target as string) ||
        (!(context.backend === "herdr" && owned.target === "tab") && owned.id !== context.surface)) {
      throw new Error(i18n.t("rename.invalidContext"));
    }
  }
  return context as unknown as SurfaceRenameContext;
}

export interface ResolveRenameOptions {
  tab: boolean;
  workspace: boolean;
  backend?: MuxBackend | null;
  env?: NodeJS.ProcessEnv;
}

/** 新的明确目标路径只判断后端能力；旧公开 API 的环境开关不参与这里。 */
function explicitRenameCapability(
  operation: RenameOperation,
  backend: MuxBackend | null,
): { backend: MuxBackend; target: RenameTarget } | undefined {
  if (!backend) return undefined;
  if (operation === "tab") {
    const target: Record<MuxBackend, RenameTarget> = {
      muxy: "pane", cmux: "tab", tmux: "window", zellij: "pane", wezterm: "tab",
      herdr: "tab", otty: "tab", orca: "terminal",
    };
    return { backend, target: target[backend] };
  }
  const target: Partial<Record<MuxBackend, RenameTarget>> = {
    cmux: "workspace", tmux: "session", wezterm: "window", herdr: "workspace",
  };
  return target[backend] ? { backend, target: target[backend] } : undefined;
}

/** 返回当前进程的明确目标 ID，不以当前焦点或第一个 tab 代替未知身份。 */
function currentTargetId(reference: { backend: MuxBackend; operation: RenameOperation; env: NodeJS.ProcessEnv }, query: RenameIdQuery): string | undefined {
  const { backend, operation, env } = reference;
  const surfaceKeys: Record<MuxBackend, string> = {
    cmux: "CMUX_SURFACE_ID", muxy: "MUXY_PANE_ID", tmux: "TMUX_PANE", zellij: "ZELLIJ_PANE_ID",
    wezterm: "WEZTERM_PANE", herdr: "HERDR_TAB_ID", otty: "OTTY_PANE_ID", orca: "ORCA_TERMINAL_HANDLE",
  };
  if (backend === "tmux") {
    const pane = env.TMUX_PANE;
    return pane ? query("tmux", [...RENAME_COMMANDS.tmuxLookup, pane,
      operation === "tab" ? RENAME_COMMANDS.tmuxWindowId : RENAME_COMMANDS.tmuxSessionId]).trim() : undefined;
  }
  if (backend === "otty") {
    const pane = env.OTTY_PANE_ID ?? AGENT_OTTY_PANE_ID;
    return pane ? getTabIdForPane(pane) ?? undefined : undefined;
  }
  if (operation === "workspace" && backend === "cmux") return env.CMUX_WORKSPACE_ID;
  if (operation === "workspace" && backend === "herdr") return env.HERDR_WORKSPACE_ID;
  return env[surfaceKeys[backend]];
}

export type RenameIdQuery = (command: string, args: string[]) => string;

/** 查询父 window/session 的明确身份，限制外部命令等待时间。 */
function queryRenameId(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
}

/** 解析一次批量改名的目标；各目标的失败、关闭或跳过分别保留。 */
export function resolveTerminalRenameTargets(options: ResolveRenameOptions, query: RenameIdQuery = queryRenameId): TerminalRenameOutcome[] {
  const env = options.env ?? process.env;
  const context = readSurfaceRenameContext(env);
  const backend = options.backend === undefined ? getMuxBackend() : options.backend;
  const outcomes: TerminalRenameOutcome[] = [];
  for (const operation of ["workspace", "tab"] as const) {
    if (!options[operation]) continue;
    if (context) {
      if (operation === "workspace") {
        outcomes.push({ status: "skipped", operation, reason: "shared" });
      } else if (!context.ownedTarget || !backend || context.backend !== backend) {
        outcomes.push({ status: "skipped", operation, reason: "unverified" });
      } else {
        outcomes.push({ status: "ready", reference: { backend, operation, ...context.ownedTarget, scope: "surface" } });
      }
      continue;
    }
    const capability = explicitRenameCapability(operation, backend);
    if (!capability) {
      outcomes.push({ status: "skipped", operation, reason: "unsupported" });
      continue;
    }
    try {
      const id = currentTargetId({ backend: capability.backend, operation, env }, query);
      outcomes.push(id?.trim() ? { status: "ready", reference: {
        backend: capability.backend, operation, target: capability.target, id,
        scope: operation === "workspace" || ["tmux", "wezterm", "herdr", "otty", "orca"].includes(capability.backend) ? "shared" : "surface",
      } } : { status: "skipped", operation, reason: "missing-id" });
    } catch (error) {
      outcomes.push({ status: "failed", operation, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

export type RenameCommandRunner = (command: string, args: string[]) => void;

/** 改名命令设置超时，异常留给调用方转成逐目标结果。 */
function runRenameCommand(command: string, args: string[]): void {
  execFileSync(command, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
}

/** 用解析时捕获的身份执行改名，不再查询当前焦点。 */
export function renameTerminalTarget(
  reference: TerminalRenameTarget,
  title: string,
  dependencies: { run: RenameCommandRunner; renameOrca: typeof renameOrcaTerminal } = { run: runRenameCommand, renameOrca: renameOrcaTerminal },
): TerminalRenameOutcome {
  const { backend, operation, target, id } = reference;
  const { run, renameOrca } = dependencies;
  try {
    if (!id.trim()) throw new Error(i18n.t("rename.missingId"));
    switch (backend) {
      case "cmux":
        run("cmux", operation === "tab" ? [...RENAME_COMMANDS.cmuxTab, id, title]
          : [...RENAME_COMMANDS.cmuxWorkspace, id, ...RENAME_COMMANDS.cmuxWorkspaceAction, title]);
        break;
      case "muxy": run("muxy", [...RENAME_COMMANDS.muxy, id, title]); break;
      case "tmux": run("tmux", [...(operation === "tab" ? RENAME_COMMANDS.tmuxTab : RENAME_COMMANDS.tmuxWorkspace), id, title]); break;
      case "zellij": run("zellij", [...RENAME_COMMANDS.zellij, title, RENAME_COMMANDS.paneId, id]); break;
      case "wezterm": run("wezterm", [...(operation === "tab" ? RENAME_COMMANDS.weztermTab : RENAME_COMMANDS.weztermWorkspace), id, title]); break;
      case "herdr": run("herdr", [target, RENAME_COMMANDS.herdr, id, title]); break;
      case "otty": run("otty", [...RENAME_COMMANDS.otty, id, title]); break;
      case "orca":
        if (!renameOrca(id, title)) throw new Error(i18n.t("error.renameIncomplete", { backend }));
        break;
    }
    return { status: "renamed", reference };
  } catch (error) {
    return { status: "failed", operation, error: error instanceof Error ? error.message : String(error) };
  }
}
