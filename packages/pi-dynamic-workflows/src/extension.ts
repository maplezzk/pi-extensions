import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import { Type } from "typebox";
import { loadConfig, saveConfig } from "./config.ts";
import { cancelRunningWorkflow, createWorkflowTool, renderWorkflowThemed } from "./index.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));
const LOG_PREFIX = "[pi-dynamic-workflows]";

export default function extension(pi: ExtensionAPI) {
  // Subagent session 不注册 workflow 工具：subagent 是 workflow 的执行节点，
  // 不应再拥有启动 workflow 的能力（防止递归调用、误激活、误取消等）。
  // pi-interactive-subagents 启动子 pi session 时会设置 PI_SUBAGENT_NAME。
  if (process.env.PI_SUBAGENT_NAME) {
    return;
  }

  const config = loadConfig();
  const workflowTool = createWorkflowTool({ pi });
  pi.registerTool(workflowTool);

  // 异步模式：注册 workflow_cancel 工具
  if (config.async) {
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
    pi.registerTool(cancelTool);
  }

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

  registerConfigCommand(pi);

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    const toolNames = [workflowTool.name];
    if (loadConfig().async) toolNames.push("workflow_cancel");
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

/** /workflow-config 交互式配置命令：切换执行后端与异步模式，持久化到 JSON。 */
function registerConfigCommand(pi: ExtensionAPI) {
  pi.registerCommand("workflow-config", {
    description: i18n.t("commandDescription"),
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      while (true) {
        const cfg = loadConfig();
        const EXIT = i18n.t("exit");
        const on = i18n.t("on");
        const off = i18n.t("off");
        const choices = [
          i18n.t("toggleBackend", { value: cfg.backend }),
          i18n.t("toggleAsync", { value: cfg.async ? on : off }),
          EXIT,
        ];
        const choice = await ctx.ui.select(i18n.t("configTitle"), choices);
        if (choice === undefined || choice === EXIT) return;

        if (choice === choices[0]) {
          const saved = saveConfig({ backend: cfg.backend === "subagent" ? "workflow" : "subagent" });
          ctx.ui.notify(`${LOG_PREFIX} ${i18n.t("savedBackend", { value: saved.backend })}`, "info");
        } else if (choice === choices[1]) {
          const saved = saveConfig({ async: !cfg.async });
          ctx.ui.notify(
            `${LOG_PREFIX} ${i18n.t("savedAsync", { value: saved.async ? on : off })} ${i18n.t("reloadHint")}`,
            "info",
          );
        }
      }
    },
  });
}
