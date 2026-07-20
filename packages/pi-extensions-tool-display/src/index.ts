import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
} from "./config-store.js";
import {
  applyCapabilityConfigGuards,
  detectToolDisplayCapabilities,
  type ToolDisplayCapabilities,
} from "./capabilities.js";
import { registerToolDisplayOverrides } from "./tool-overrides.js";
import { disposeAll, resetDisposed } from "./disposable.js";
import { registerThinkingLabeling } from "./thinking-label.js";
import registerNativeUserMessageBox from "./user-message-box-native.js";
import {
  BUILT_IN_TOOL_OVERRIDE_NAMES,
  type ConfigLoadResult,
  type ToolDisplayConfig,
} from "./types.js";

export * from "./result-render-middleware.js";

function ownershipChanged(
  previous: ToolDisplayConfig,
  next: ToolDisplayConfig,
): boolean {
  return BUILT_IN_TOOL_OVERRIDE_NAMES.some(
    (toolName) =>
      previous.registerToolOverrides[toolName] !==
      next.registerToolOverrides[toolName],
  );
}

export function toolDisplayReloadRequired(
  previous: ToolDisplayConfig,
  next: ToolDisplayConfig,
): boolean {
  return previous.enabled !== next.enabled || ownershipChanged(previous, next);
}

const initializedHosts = new WeakSet<ExtensionAPI>();

/**
 * Load the display host when a feature extension uses this package as a
 * dependency. Pi only auto-loads top-level packages, so relying on the
 * dependency's `pi.extensions` metadata alone would leave the middleware
 * queue undrained for users who install `pi-distill` or `pi-tool-supervisor`.
 */
export function ensureToolDisplayHost(
  pi: ExtensionAPI,
  initial: ConfigLoadResult = loadToolDisplayConfig(),
): void {
  if (initializedHosts.has(pi)) return;
  initializedHosts.add(pi);

  resetDisposed();

  pi.on("session_shutdown", (event: { reason: string }) => {
    if (event.reason === "reload") {
      disposeAll();
      initializedHosts.delete(pi);
    }
  });

  let config: ToolDisplayConfig = initial.config;
  let pendingLoadError = initial.error;
  let capabilities: ToolDisplayCapabilities = {
    hasMcpTooling: false,
    hasRtkOptimizer: false,
  };

  const refreshCapabilities = (): void => {
    capabilities = detectToolDisplayCapabilities(pi, process.cwd());
  };

  const getConfig = (): ToolDisplayConfig => config;
  const getCapabilities = (): ToolDisplayCapabilities => capabilities;
  const getEffectiveConfig = (): ToolDisplayConfig =>
    applyCapabilityConfigGuards(config, capabilities);

  const setConfig = (
    next: ToolDisplayConfig,
    ctx: ExtensionCommandContext,
  ): void => {
    const normalized = normalizeToolDisplayConfig(next);
    const requiresReload = toolDisplayReloadRequired(config, normalized);
    config = normalized;

    const saved = saveToolDisplayConfig(normalized);
    if (!saved.success && saved.error) {
      ctx.ui.notify(saved.error, "error");
    }

    if (requiresReload) {
      ctx.ui.notify(
        "Global switch or tool ownership updates apply after /reload.",
        "warning",
      );
    }
  };

  if (initial.config.enabled) {
    registerToolDisplayOverrides(pi, getEffectiveConfig);
    registerNativeUserMessageBox(pi, getConfig);
    registerThinkingLabeling(pi);
  }

  pi.registerCommand("tool-display", {
    description: "Configure tool output rendering (OpenCode-style)",
    handler: async (args, ctx) => {
      const { runToolDisplayCommandHandler } = await import("./config-modal.js");
      await runToolDisplayCommandHandler(args, ctx, { getConfig, setConfig, getCapabilities });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshCapabilities();
    if (pendingLoadError) {
      ctx.ui.notify(pendingLoadError, "warning");
      pendingLoadError = undefined;
    }
  });

  pi.on("before_agent_start", async () => {
    refreshCapabilities();
  });
}

export default function toolDisplayExtension(
  pi: ExtensionAPI,
  initial: ConfigLoadResult = loadToolDisplayConfig(),
): void {
  ensureToolDisplayHost(pi, initial);
}
