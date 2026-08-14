import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { collectSessionResources, collectToolResources, ResourceIndex } from "./collector.ts";
import { i18n } from "./i18n.ts";
import { SessionResourceEditor } from "./picker.ts";

const COMMAND_NAMES = ["config:session-resources", "session-resources"] as const;
const COMMAND_ACTION = {
  enable: "enable",
  disable: "disable",
  show: "show",
  hide: "hide",
} as const;
const COMMAND_ACTIONS = Object.values(COMMAND_ACTION);
type CommandAction = (typeof COMMAND_ACTION)[keyof typeof COMMAND_ACTION];

/** Registers passive collection and the tabbed # resource picker. */
export default function sessionResourcesExtension(pi: ExtensionAPI): void {
  const resources = new ResourceIndex();
  let pickerEnabled = true;

  /** Wraps the current editor so the resource picker renders directly above it. */
  function bindResourceEditor(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const previousEditorFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const baseEditor = previousEditorFactory?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings);
      return new SessionResourceEditor(baseEditor, {
        theme,
        keybindings,
        getResources: () => resources.list(),
        isEnabled: () => pickerEnabled,
        requestRender: () => tui.requestRender(),
      });
    });
  }

  /** Rebuilds resources from the active branch after start, resume, or tree navigation. */
  function rebuildFromSession(ctx: ExtensionContext): void {
    resources.replace(collectSessionResources(ctx.sessionManager.getBranch(), ctx.cwd));
  }

  pi.on("session_start", (_event, ctx) => {
    rebuildFromSession(ctx);
    bindResourceEditor(ctx);
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
  });

  pi.on("session_shutdown", () => {
    resources.clear();
  });

  const command = {
    description: i18n.t("commandDescription"),
    /** Completes supported enable and disable actions plus legacy visibility names. */
    getArgumentCompletions: (prefix: string) => {
      const matches = COMMAND_ACTIONS.filter((action) => action.startsWith(prefix));
      return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
    },
    /** Reports usage or toggles # resource-reference completion. */
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        ctx.ui.notify(i18n.t(pickerEnabled ? "referenceHint" : "referenceDisabledHint"), "info");
        return;
      }
      if (!COMMAND_ACTIONS.includes(action as CommandAction)) {
        ctx.ui.notify(i18n.t("commandUsage"), "warning");
        return;
      }

      pickerEnabled = action === COMMAND_ACTION.enable || action === COMMAND_ACTION.show;
      ctx.ui.notify(i18n.t(pickerEnabled ? "enabled" : "disabled"), "info");
    },
  };
  for (const name of COMMAND_NAMES) pi.registerCommand(name, command);
}

export * from "./autocomplete.ts";
export * from "./collector.ts";
export * from "./picker.ts";
