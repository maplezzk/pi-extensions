import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getMuxBackend,
  getRenameCapability,
  renameCurrentTab,
  renameWorkspace,
  type MuxBackend,
  type RenameCapability,
  type RenameOperation,
  type RenameResult,
  type RenameTarget,
} from "pi-terminal-mux";
import {
  getCurrentSessionUserMessages,
  requestSessionName,
  requestSessionNameWithTimeout,
  type SessionNameRequester,
} from "./session-name.ts";
import { i18n } from "./i18n.ts";
import type { NamingConfig } from "./config.ts";

const WORKSPACE_OPERATION: RenameOperation = "workspace";
const TAB_OPERATION: RenameOperation = "tab";
const WORKSPACE_COMMAND = "rename:workspace";
const TAB_COMMAND = "rename:tab";

export type RenameDependencies = {
  getBackend: () => MuxBackend | null;
  getCapability: (
    operation: RenameOperation,
    backend?: MuxBackend | null,
  ) => RenameCapability;
  renameCurrentTab: (title: string) => RenameResult;
  renameWorkspace: (title: string) => RenameResult;
};

const DEFAULT_DEPENDENCIES: RenameDependencies = {
  getBackend: getMuxBackend,
  getCapability: getRenameCapability,
  renameCurrentTab,
  renameWorkspace,
};

/** 将内部操作名转换成用户能直接看懂的名称。 */
function operationLabel(operation: RenameOperation): string {
  return i18n.t(operation === WORKSPACE_OPERATION ? "workspaceTarget" : "tabTarget");
}

/** 将后端目标转换成双语目录中的用户文案。 */
function targetLabel(target: RenameTarget): string {
  const keyByTarget: Record<RenameTarget, string> = {
    tab: "tabTarget",
    window: "windowTarget",
    pane: "paneTarget",
    workspace: "workspaceTarget",
    session: "sessionTarget",
    terminal: "terminalTarget",
  };
  return i18n.t(keyByTarget[target]);
}

/** 将 unknown 错误转换为可展示给用户的消息。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 展示能力层的 unsupported / disabled 结果。 */
function notifyCapability(
  ctx: ExtensionCommandContext,
  capability: RenameCapability,
): void {
  if (capability.status === "unsupported") {
    ctx.ui.notify(
      i18n.t("renameUnsupported", { operation: operationLabel(capability.operation) }),
      "warning",
    );
    return;
  }

  if (capability.status === "disabled") {
    ctx.ui.notify(
      i18n.t("renameDisabled", { setting: capability.setting }),
      "warning",
    );
  }
}

/** 展示一次重命名的最终结果，并返回是否真的完成。 */
function notifyRenameResult(
  ctx: ExtensionCommandContext,
  result: RenameResult,
  label: string,
): boolean {
  if (result.status === "renamed") {
    ctx.ui.notify(
      i18n.t(
        result.operation === WORKSPACE_OPERATION
          ? "workspaceRenameDone"
          : "tabRenameDone",
        {
          label,
          target: targetLabel(result.target),
        },
      ),
      "info",
    );
    return true;
  }

  if (result.status === "unsupported") {
    ctx.ui.notify(
      i18n.t("renameUnsupported", { operation: operationLabel(result.operation) }),
      "warning",
    );
    return false;
  }

  if (result.status === "disabled") {
    ctx.ui.notify(i18n.t("renameDisabled", { setting: result.setting }), "warning");
    return false;
  }

  ctx.ui.notify(i18n.t("renameFailed", { error: result.error }), "error");
  return false;
}

/** 解析 workspace 命令的名称；省略参数时单独调用标题生成器。 */
async function resolveWorkspaceLabel(
  args: string,
  ctx: ExtensionCommandContext,
  requestName: SessionNameRequester,
): Promise<string | undefined> {
  const explicitLabel = args.trim();
  if (explicitLabel) return explicitLabel;

  const userMessages = getCurrentSessionUserMessages(ctx);
  if (userMessages.length === 0) {
    ctx.ui.notify(i18n.t("sessionNameNoMessages"), "error");
    return undefined;
  }

  return requestSessionNameWithTimeout({
    userMessages,
    ctx: ctx as Pick<ExtensionContext, "model" | "modelRegistry">,
    requestName,
  });
}

/** 读取当前后端和重命名能力；探测异常也必须对用户可见。 */
function resolveCapability(
  ctx: ExtensionCommandContext,
  dependencies: RenameDependencies,
  operation: RenameOperation,
): RenameCapability | undefined {
  try {
    const backend = dependencies.getBackend();
    const capability = dependencies.getCapability(operation, backend);
    return capability;
  } catch (error) {
    ctx.ui.notify(i18n.t("renameFailed", { error: errorMessage(error) }), "error");
    return undefined;
  }
}

/** 注册一个手动终端重命名命令。 */
function registerRenameCommand(
  pi: ExtensionAPI,
  commandName: string,
  operation: RenameOperation,
  requestName: SessionNameRequester,
  dependencies: RenameDependencies,
  state: { generation: number; request: number },
): void {
  pi.registerCommand(commandName, {
    description: i18n.t(
      operation === WORKSPACE_OPERATION
        ? "renameWorkspaceDescription"
        : "renameTabDescription",
    ),
    getArgumentCompletions: () => null,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const generation = state.generation;
      const request = ++state.request;
      const isCurrent = () => state.generation === generation && state.request === request;
      let label = args.trim();
      const capability = resolveCapability(ctx, dependencies, operation);
      if (!capability) return;
      if (capability.status !== "supported") {
        notifyCapability(ctx, capability);
        return;
      }
      if (operation === WORKSPACE_OPERATION && !label) {
        try {
          label = (await resolveWorkspaceLabel(args, ctx, requestName)) ?? "";
        } catch (error) {
          if (isCurrent()) ctx.ui.notify(i18n.t("renameFailed", { error: errorMessage(error) }), "error");
          return;
        }
        // 旧会话或被后续命令替代的结果不得改名，也不得向新会话发送通知。
        if (!isCurrent()) return;
        if (!label) return;
      }

      if (!label) {
        ctx.ui.notify(i18n.t("renameMissing", { command: commandName }), "error");
        return;
      }

      const result = operation === WORKSPACE_OPERATION
        ? dependencies.renameWorkspace(label)
        : dependencies.renameCurrentTab(label);
      if (
        notifyRenameResult(ctx, result, label) &&
        operation === WORKSPACE_OPERATION &&
        result.status === "renamed"
      ) {
        // 只有终端 workspace 真正改名成功后，才同步 Pi session 名称。
        pi.setSessionName(label);
      }
    },
  });
}

/** 注册手动 workspace/tab 重命名命令；不会注册自动命名监听。 */
export function registerTerminalRename(
  pi: ExtensionAPI,
  requestName: SessionNameRequester = requestSessionName,
  dependencies: RenameDependencies = DEFAULT_DEPENDENCIES,
  enabled: Pick<NamingConfig, "workspaceRename" | "tabRename"> = { workspaceRename: true, tabRename: true },
): void {
  if (!enabled.workspaceRename && !enabled.tabRename) return;
  const state = { generation: 0, request: 0 };
  pi.on("session_start", () => { state.generation += 1; });
  pi.on("session_shutdown", () => { state.generation += 1; });
  if (enabled.workspaceRename) registerRenameCommand(
    pi,
    WORKSPACE_COMMAND,
    WORKSPACE_OPERATION,
    requestName,
    dependencies,
    state,
  );
  if (enabled.tabRename) registerRenameCommand(
    pi,
    TAB_COMMAND,
    TAB_OPERATION,
    requestName,
    dependencies,
    state,
  );
}

