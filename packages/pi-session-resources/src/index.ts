import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createResourceAutocompleteProvider,
  routeResourceAutocompleteInput,
  type ResourceAutocompleteState,
} from "./autocomplete.ts";
import { collectSessionResources, collectToolResources, ResourceIndex } from "./collector.ts";
import { i18n } from "./i18n.ts";

const COMMAND_NAMES = ["config:session-resources", "session-resources"] as const;
const COMMAND_ACTION = {
  enable: "enable",
  disable: "disable",
  show: "show",
  hide: "hide",
} as const;
const COMMAND_ACTIONS = Object.values(COMMAND_ACTION);
type CommandAction = (typeof COMMAND_ACTION)[keyof typeof COMMAND_ACTION];

/** Registers passive collection and # resource-reference autocomplete. */
export default function sessionResourcesExtension(pi: ExtensionAPI): void {
  const resources = new ResourceIndex();
  const autocompleteState: ResourceAutocompleteState = { active: false };
  let autocompleteEnabled = true;
  let removeTerminalInputListener: (() => void) | undefined;

  /** Installs the built-in autocomplete wrapper and Tab-to-next input routing. */
  function bindAutocomplete(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) =>
      createResourceAutocompleteProvider({
        current,
        getResources: () => (autocompleteEnabled ? resources.list() : []),
        onActiveChange: (active) => {
          autocompleteState.active = autocompleteEnabled && active;
        },
      }),
    );
    removeTerminalInputListener?.();
    removeTerminalInputListener = ctx.ui.onTerminalInput((data) =>
      routeResourceAutocompleteInput(data, autocompleteState),
    );
  }

  /** Rebuilds resources from the active branch after start, resume, or tree navigation. */
  function rebuildFromSession(ctx: ExtensionContext): void {
    resources.replace(collectSessionResources(ctx.sessionManager.getBranch(), ctx.cwd));
  }

  pi.on("session_start", (_event, ctx) => {
    rebuildFromSession(ctx);
    bindAutocomplete(ctx);
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
    removeTerminalInputListener?.();
    removeTerminalInputListener = undefined;
    autocompleteState.active = false;
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
        ctx.ui.notify(i18n.t(autocompleteEnabled ? "referenceHint" : "referenceDisabledHint"), "info");
        return;
      }
      if (!COMMAND_ACTIONS.includes(action as CommandAction)) {
        ctx.ui.notify(i18n.t("commandUsage"), "warning");
        return;
      }

      autocompleteEnabled = action === COMMAND_ACTION.enable || action === COMMAND_ACTION.show;
      if (!autocompleteEnabled) autocompleteState.active = false;
      ctx.ui.notify(i18n.t(autocompleteEnabled ? "enabled" : "disabled"), "info");
    },
  };
  for (const name of COMMAND_NAMES) pi.registerCommand(name, command);
}

export * from "./autocomplete.ts";
export * from "./collector.ts";
