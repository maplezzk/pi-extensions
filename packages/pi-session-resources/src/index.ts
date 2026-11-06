import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { collectSessionResources, collectToolResources, ResourceIndex } from "./collector.ts";
import { i18n } from "./i18n.ts";
import { isFullscreenTui, SessionResourceEditor } from "./picker.ts";
import { configPath, loadConfig, saveConfig } from "./config.ts";
import { openConfigPanel } from "./config-panel.ts";
import { NOTICE_TAG_COLOR, installNoticeRenderer, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
const NOTICE_TAG = "resources";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

/** 统一提示出口：加来源标签后交给 Pi 的 notify，避免用户分不清消息来源。 */
function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  notifyWithSource({ ctx, source: NOTICE_SOURCE, level, message });
}

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
  // 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
  installNoticeRenderer(pi);
  const resources = new ResourceIndex();
  let pickerEnabled = true;
  let configError: unknown;
  try {
    pickerEnabled = loadConfig().enabled;
  } catch (error) {
    configError = error;
  }

  /** Wraps the current editor so the resource picker renders directly above it. */
  function bindResourceEditor(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const previousEditorFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const baseEditor = previousEditorFactory?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings);
      return new SessionResourceEditor(baseEditor, {
        theme: ctx.ui.theme,
        keybindings,
        getResources: () => resources.list(),
        isEnabled: () => pickerEnabled,
        isMouseEnabled: () => isFullscreenTui(tui),
        requestRender: () => tui.requestRender(),
      });
    });
  }

  /** Rebuilds resources from the active branch after start, resume, or tree navigation. */
  function rebuildFromSession(ctx: ExtensionContext): void {
    resources.replace(collectSessionResources(ctx.sessionManager.getBranch(), ctx.cwd));
  }

  pi.on("session_start", (_event, ctx) => {
    if (configError !== undefined) {
      notify(ctx, i18n.t("configLoadFailed", {
        path: configPath(),
        error: configError instanceof Error ? configError.message : String(configError),
      }), "warning");
    }
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

  /**
   * Persists the picker switch and reports a write failure.
   *
   * Both the command actions and the panel go through here, so the running
   * session and the file can never disagree.
   */
  function applyEnabled(enabled: boolean, ctx: ExtensionCommandContext): void {
    try {
      saveConfig({ enabled });
      pickerEnabled = enabled;
      notify(ctx, i18n.t(pickerEnabled ? "enabled" : "disabled"), "info");
    } catch (error) {
      notify(ctx, i18n.t("configSaveFailed", {
        path: configPath(),
        error: error instanceof Error ? error.message : String(error),
      }), "error");
    }
  }

  /** Opens the TUI configuration panel bound to the live picker state. */
  async function openPanel(ctx: ExtensionCommandContext): Promise<void> {
    await openConfigPanel(ctx, {
      getConfig: () => ({ enabled: pickerEnabled }),
      onChange: (next) => applyEnabled(next.enabled, ctx),
    });
  }

  const command = {
    description: i18n.t("commandDescription"),
    /** Completes supported enable and disable actions plus legacy visibility names. */
    getArgumentCompletions: (prefix: string) => {
      const matches = COMMAND_ACTIONS.filter((action) => action.startsWith(prefix));
      return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
    },
    /** Reports usage, opens the panel, or toggles # resource-reference completion. */
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        await openPanel(ctx);
        return;
      }
      if (!COMMAND_ACTIONS.includes(action as CommandAction)) {
        notify(ctx, i18n.t("commandUsage"), "warning");
        return;
      }

      applyEnabled(action === COMMAND_ACTION.enable || action === COMMAND_ACTION.show, ctx);
    },
  };
  for (const name of COMMAND_NAMES) pi.registerCommand(name, command);
}

export { configPath, loadConfig, parseConfig, saveConfig } from "./config.ts";
export * from "./config-panel.ts";
export * from "./autocomplete.ts";
export * from "./collector.ts";
export * from "./picker.ts";
