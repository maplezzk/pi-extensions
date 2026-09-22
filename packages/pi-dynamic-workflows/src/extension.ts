import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createTranslator, installNoticeRenderer, loadCatalog, notifyWithSource } from "pi-extensions-i18n";
import { Type } from "typebox";
import { openConfigPanel } from "./config-panel.ts";
import { loadConfig, saveConfig, type WorkflowConfig } from "./config.ts";
import { cancelRunningWorkflow, createWorkflowTool, renderWorkflowThemed } from "./index.ts";
import { NOTICE_SOURCE } from "./notice.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

export default function extension(pi: ExtensionAPI) {
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  // Subagent session 不注册 workflow 工具：subagent 是 workflow 的执行节点，
  // 不应再拥有启动 workflow 的能力（防止递归调用、误激活、误取消等）。
  // pi-interactive-subagents 启动子 pi session 时会设置 PI_SUBAGENT_NAME。
  if (process.env.PI_SUBAGENT_NAME) {
    return;
  }

  const config = loadConfig();
  /** 当前注册的 workflow_cancel 工具；异步模式关闭时为空。 */
  let activeCancelTool: ToolDefinition | undefined;
  // 热重载：异步模式判定每次调用时现取，所以面板改一项后续调用立刻按新配置走（不用 /reload）。
  const workflowTool = createWorkflowTool({ pi, isAsync: () => activeCancelTool !== undefined });
  pi.registerTool(workflowTool);

  /** 注册异步模式专属的 workflow_cancel 工具。 */
  const registerCancelTool = (): ToolDefinition => {
    const cancelTool = defineTool({
      name: "workflow_cancel",
      label: "Cancel Workflow",
      description: i18n.t("cancelToolDescription"),
      promptSnippet: "Cancel a running background workflow.",
      parameters: Type.Object({}),
      async execute() {
        const result = cancelRunningWorkflow();
        if (result.cancelled) {
          return {
            content: [{ type: "text", text: i18n.t("cancelSent", { name: result.name }) }],
            details: {},
          };
        }
        return {
          content: [{ type: "text", text: i18n.t("noneRunning") }],
          details: {},
        };
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold("workflow_cancel")), 0, 0);
      },
    });
    return cancelTool;
  };

  // 异步模式：注册 workflow_cancel 工具
  if (config.background) {
    activeCancelTool = registerCancelTool();
    pi.registerTool(activeCancelTool);
  }

  /**
   * 按一份新配置调整工作区：后续调用看到新配置，正在运行的 workflow 不被打断。
   * 工具注册是一次性的，所以这里只挂上 workflow_cancel；异步关闭时仅改标志位。
   */
  const applyConfig = (next: WorkflowConfig): void => {
    if (next.background === (activeCancelTool !== undefined)) return;
    if (next.background) {
      activeCancelTool = registerCancelTool();
      pi.registerTool(activeCancelTool);
      return;
    }
    activeCancelTool = undefined;
  };

  // 注册异步模式的结果消息渲染器
  pi.registerMessageRenderer("workflow_result", (message: any, _options: any, theme: any) => {
    const snapshot = message.details;
    if (!snapshot?.name) return undefined;

    return {
      render(width: number): string[] {
        const hasError = snapshot.errorCount > 0;
        const bgFn = hasError
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = hasError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = hasError ? "completed with errors" : "completed";
        const elapsed = snapshot.durationMs ? `${Math.round(snapshot.durationMs / 1000)}s` : "?";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(`Workflow: ${snapshot.name}`))} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;

        const contentLines = [header, ""];
        const themed = renderWorkflowThemed(snapshot, theme, {
          key: "workflow",
          maxAgents: 4,
          maxLogs: 1,
          showResultPreviews: true,
        });
        contentLines.push(...themed.split("\n"));

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
      invalidate(): void {},
    };
  });

  registerConfigCommand(pi, applyConfig);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const toolNames = [workflowTool.name];
    if (activeCancelTool !== undefined) toolNames.push("workflow_cancel");
    for (const name of toolNames) {
      if (!active.includes(name)) {
        pi.setActiveTools([...pi.getActiveTools(), name]);
      }
    }
  });

  // 会话关闭时取消运行中的异步 workflow
  pi.on("session_shutdown", () => {
    cancelRunningWorkflow();
  });
}

/** /config:workflow 配置面板命令；旧名称保留为兼容别名。 */
function registerConfigCommand(pi: ExtensionAPI, applyConfig: (config: WorkflowConfig) => void) {
  const command = {
    description: i18n.t("commandDescription"),
    /** 保存成功后立刻热重载工具，让新配置在本次会话生效。 */
    onChange(ctx: ExtensionCommandContext, next: WorkflowConfig): void {
      try {
        const saved = saveConfig(next);
        applyConfig(saved);
        notifyWithSource({
          ctx,
          source: NOTICE_SOURCE,
          level: "info",
          message: i18n.t("configSaved", {
            backend: saved.backend,
            async: saved.background ? i18n.t("on") : i18n.t("off"),
          }),
        });
      } catch (error) {
        notifyWithSource({
          ctx,
          source: NOTICE_SOURCE,
          level: "error",
          message: i18n.t("configSaveFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    },
    /** 打开配置面板；每改一项都保存并立即生效，Esc 关闭。 */
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) return;
      await openConfigPanel(ctx, {
        getConfig: () => loadConfig(),
        onChange: (next) => command.onChange(ctx, next),
      });
    },
  };
  for (const name of ["config:workflow", "workflow-config", "pi-workflow-config"] as const) {
    pi.registerCommand(name, command);
  }
}
