import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectSessionResources, collectToolResources, ResourceIndex } from "./collector.ts";
import { i18n } from "./i18n.ts";
import { renderResourceWidget } from "./render.ts";

const WIDGET_KEY = "session-resources";
const COMMAND_ACTIONS = ["show", "hide", "expand", "collapse"] as const;
type CommandAction = (typeof COMMAND_ACTIONS)[number];

/** Registers passive resource collection and the clickable session widget. */
export default function sessionResourcesExtension(pi: ExtensionAPI): void {
  const resources = new ResourceIndex();
  let widgetVisible = true;
  let widgetExpanded = false;

  /** Replaces the widget so Pi requests a render with the latest immutable snapshot. */
  function refreshWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const snapshot = resources.list();
    if (!widgetVisible || snapshot.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        /** Renders links from the snapshot captured when the widget was refreshed. */
        render(width: number): string[] {
          return renderResourceWidget({ resources: snapshot, width, expanded: widgetExpanded, theme });
        },
        /** The widget has no themed cache to invalidate. */
        invalidate(): void {},
      }),
      { placement: "belowEditor" },
    );
  }

  /** Rebuilds resources from the active branch after start, resume, or tree navigation. */
  function rebuildFromSession(ctx: ExtensionContext): void {
    resources.replace(collectSessionResources(ctx.sessionManager.getBranch(), ctx.cwd));
    refreshWidget(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    rebuildFromSession(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    rebuildFromSession(ctx);
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    resources.observe(
      collectToolResources({
        toolName: event.toolName,
        input: event.input,
        content: event.content,
        details: event.details,
        cwd: ctx.cwd,
        timestamp: Date.now(),
      }),
    );
    refreshWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
    resources.clear();
  });

  pi.registerCommand("session-resources", {
    description: i18n.t("commandDescription"),
    getArgumentCompletions: (prefix) => {
      const matches = COMMAND_ACTIONS.filter((action) => action.startsWith(prefix));
      return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action && !COMMAND_ACTIONS.includes(action as CommandAction)) {
        ctx.ui.notify(i18n.t("commandUsage"), "warning");
        return;
      }

      if (action === "hide") {
        widgetVisible = false;
        refreshWidget(ctx);
        ctx.ui.notify(i18n.t("hidden"), "info");
        return;
      }

      widgetVisible = true;
      if (action === "show") {
        widgetExpanded = false;
        ctx.ui.notify(i18n.t("shown"), "info");
      } else if (action === "expand") {
        widgetExpanded = true;
        ctx.ui.notify(i18n.t("expanded"), "info");
      } else if (action === "collapse") {
        widgetExpanded = false;
        ctx.ui.notify(i18n.t("collapsed"), "info");
      } else {
        widgetExpanded = !widgetExpanded;
        ctx.ui.notify(i18n.t(widgetExpanded ? "expanded" : "collapsed"), "info");
      }

      if (resources.list().length === 0) ctx.ui.notify(i18n.t("empty"), "info");
      refreshWidget(ctx);
    },
  });
}

export * from "./collector.ts";
export * from "./render.ts";
