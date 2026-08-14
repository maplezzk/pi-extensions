import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ResourceBrowser } from "./browser.ts";
import { collectSessionResources, collectToolResources, ResourceIndex } from "./collector.ts";
import { i18n } from "./i18n.ts";
import {
  renderResourceWidget,
  resolveResourceTab,
  type ResourceTab,
} from "./render.ts";

const WIDGET_KEY = "session-resources";
const BROWSER_SHORTCUT = "ctrl+up";
const COMMAND_NAMES = ["config:session-resources", "session-resources"] as const;
const COMMAND_ACTIONS = ["show", "hide", "expand", "collapse"] as const;
type CommandAction = (typeof COMMAND_ACTIONS)[number];

/** Registers passive resource collection and the clickable session widget. */
export default function sessionResourcesExtension(pi: ExtensionAPI): void {
  const resources = new ResourceIndex();
  let widgetVisible = true;
  let browserOpen = false;
  let activeTab: ResourceTab | undefined;

  /** Replaces the widget so Pi requests a render with the latest immutable snapshot. */
  function refreshWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const snapshot = resources.list();
    if (!widgetVisible || browserOpen || snapshot.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    activeTab = resolveResourceTab(snapshot, activeTab);
    const selectedTab = activeTab;
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      /** Renders links from the snapshot captured when the widget was refreshed. */
      render(width: number): string[] {
        return renderResourceWidget({
          resources: snapshot,
          width,
          expanded: ctx.ui.getToolsExpanded(),
          activeTab: selectedTab,
          theme,
        });
      },
      /** The widget has no themed cache to invalidate. */
      invalidate(): void {},
    }));
  }

  /** Replaces the editor with the focusable browser while temporarily hiding the passive widget. */
  async function openResourceBrowser(ctx: ExtensionContext): Promise<void> {
    if (browserOpen) return;
    const snapshot = resources.list();
    if (snapshot.length === 0) {
      ctx.ui.notify(i18n.t("empty"), "info");
      return;
    }

    activeTab = resolveResourceTab(snapshot, activeTab);
    browserOpen = true;
    refreshWidget(ctx);
    try {
      await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
        /** Reads Pi's canonical Ctrl+O expansion state. */
        function getExpanded(): boolean {
          return ctx.ui.getToolsExpanded();
        }

        /** Updates Pi's canonical Ctrl+O expansion state. */
        function setExpanded(expanded: boolean): void {
          ctx.ui.setToolsExpanded(expanded);
        }

        /** Persists the selected resource tab after the browser closes. */
        function onTabChange(tab: ResourceTab): void {
          activeTab = tab;
        }

        /** Closes the browser and lets Pi restore the editor in the same layout slot. */
        function onClose(): void {
          done(true);
        }

        /** Requests an immediate repaint after local browser state changes. */
        function requestRender(): void {
          tui.requestRender();
        }

        return new ResourceBrowser({
          resources: snapshot,
          activeTab: activeTab ?? resolveResourceTab(snapshot),
          theme,
          keybindings,
          getExpanded,
          setExpanded,
          onTabChange,
          onClose,
          requestRender,
        });
      });
    } finally {
      browserOpen = false;
      refreshWidget(ctx);
    }
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

  const command = {
    description: i18n.t("commandDescription"),
    /** Completes only supported visibility and expansion actions. */
    getArgumentCompletions: (prefix: string) => {
      const matches = COMMAND_ACTIONS.filter((action) => action.startsWith(prefix));
      return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
    },
    /** Opens the browser or applies the requested in-memory widget state. */
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase();
      if (action && !COMMAND_ACTIONS.includes(action as CommandAction)) {
        ctx.ui.notify(i18n.t("commandUsage"), "warning");
        return;
      }
      if (!action) {
        await openResourceBrowser(ctx);
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
        ctx.ui.notify(i18n.t("shown"), "info");
      } else {
        let expanded = !ctx.ui.getToolsExpanded();
        if (action === "expand") expanded = true;
        else if (action === "collapse") expanded = false;
        ctx.ui.setToolsExpanded(expanded);
        ctx.ui.notify(i18n.t(expanded ? "expanded" : "collapsed"), "info");
      }

      if (resources.list().length === 0) ctx.ui.notify(i18n.t("empty"), "info");
      refreshWidget(ctx);
    },
  };
  for (const name of COMMAND_NAMES) pi.registerCommand(name, command);
  pi.registerShortcut(BROWSER_SHORTCUT, {
    description: i18n.t("browserShortcutDescription"),
    handler: openResourceBrowser,
  });
}

export * from "./browser.ts";
export * from "./collector.ts";
export * from "./render.ts";
