import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installNoticeRenderer, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";
import { catalogDocPath, configPath } from "./agent-dir.ts";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type JsonRenderConfig } from "./config.ts";
import { renderCatalogDoc } from "./catalog-doc.ts";
import { compositionAvailability, coreSupportsComposition, resolveComposition, type CompositionAvailability } from "./compose.ts";
import { createComposeUiTool } from "./compose-tool.ts";
import { createRenderUiTool } from "./tool.ts";
import { i18n } from "./i18n.ts";

/** Short, unique source tag for this package's notices. */
const NOTICE_TAG = "ui";
/** Notice tag color, distinct from other packages. */
const NOTICE_COLOR: NoticeColor = "accent";
/** Notice source descriptor. */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

/** Primary command name plus its short alias. */
const COMMAND_NAMES = ["config:gen-ui", "gen-ui"] as const;
/** Supported command actions. */
const COMMAND_ACTIONS = ["enable", "disable", "status", "catalog"] as const;
type CommandAction = (typeof COMMAND_ACTIONS)[number];

/** Send a notice through the shared i18n notice renderer. */
function notify(
  ctx: ExtensionContext | ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  notifyWithSource({ ctx, source: NOTICE_SOURCE, level, message });
}

/** Write the generated component reference next to the configuration file. */
function writeCatalogReference(): string {
  const path = catalogDocPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderCatalogDoc(), "utf8");
  return path;
}

/** Human-readable composition state for the status notice. */
function compositionState(availability: CompositionAvailability, config: JsonRenderConfig): string {
  if (!availability.available) return availability.reason ?? "unavailable";
  const resolved = resolveComposition({ config });
  return resolved ? `${resolved.provider} (${resolved.keyEnv})` : "available";
}

/**
 * Register the render_ui tool, the optional compose_ui tool, and the configuration command.
 *
 * Async because composition support depends on whether the installed
 * `@json-render/core` still exports the experimental composer.
 */
export default async function jsonRenderExtension(pi: ExtensionAPI): Promise<void> {
  installNoticeRenderer(pi);

  let configError: unknown;
  let config: JsonRenderConfig = { ...DEFAULT_CONFIG, composition: { ...DEFAULT_CONFIG.composition } };
  try {
    config = loadConfig();
  } catch (error) {
    configError = error;
  }

  const availability = compositionAvailability({
    config,
    coreSupportsComposition: await coreSupportsComposition(),
  });

  pi.registerTool(createRenderUiTool({ getConfig: () => config }));
  if (availability.available) {
    pi.registerTool(createComposeUiTool({ getConfig: () => config, getAvailability: () => availability }));
  }

  pi.on("session_start", (_event, ctx) => {
    if (configError !== undefined) {
      notify(
        ctx,
        i18n.t("configLoadFailed", {
          path: configPath(),
          error: configError instanceof Error ? configError.message : String(configError),
        }),
        "warning",
      );
      configError = undefined;
    }

    // Only speak up when the user asked for composition and something blocks it;
    // an explicitly disabled composer needs no session-start noise.
    if (!availability.available && availability.reason !== "disabled") {
      notify(
        ctx,
        i18n.t(availability.reason === "unsupportedCore" ? "composeUnsupportedCore" : "composeMissingKey"),
        "warning",
      );
    }

    try {
      writeCatalogReference();
    } catch (error) {
      notify(
        ctx,
        i18n.t("catalogCommandFailed", {
          path: catalogDocPath(),
          error: error instanceof Error ? error.message : String(error),
        }),
        "warning",
      );
    }
  });

  /** Report the effective configuration, including the generated catalog path. */
  function reportStatus(ctx: ExtensionCommandContext): void {
    notify(
      ctx,
      i18n.t("status", {
        state: config.enabled ? "enabled" : "disabled",
        maxLines: config.maxResultLines,
        view: config.interactiveView,
        composition: compositionState(availability, config),
        catalog: catalogDocPath(),
      }),
      "info",
    );
  }

  /** Persist a configuration change and report a write failure. */
  function applyConfig(ctx: ExtensionCommandContext, next: JsonRenderConfig): void {
    config = next;
    try {
      saveConfig(next);
    } catch (error) {
      notify(
        ctx,
        i18n.t("configSaveFailed", {
          path: configPath(),
          error: error instanceof Error ? error.message : String(error),
        }),
        "error",
      );
    }
  }

  /** Handle `enable`, `disable`, `status`, and `catalog`. */
  async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    const action = (rawArgs.trim().split(/\s+/)[0] || "status") as CommandAction;
    if (!(COMMAND_ACTIONS as readonly string[]).includes(action)) {
      notify(ctx, i18n.t("commandUsage"), "warning");
      return;
    }
    if (action === "status") {
      reportStatus(ctx);
      return;
    }
    if (action === "catalog") {
      try {
        notify(ctx, i18n.t("catalogWritten", { path: writeCatalogReference() }), "info");
      } catch (error) {
        notify(
          ctx,
          i18n.t("catalogCommandFailed", {
            path: catalogDocPath(),
            error: error instanceof Error ? error.message : String(error),
          }),
          "error",
        );
      }
      return;
    }
    const enabled = action === "enable";
    applyConfig(ctx, { ...config, enabled });
    notify(ctx, enabled ? i18n.t("enabled") : i18n.t("disabled"), "info");
  }

  for (const name of COMMAND_NAMES) {
    pi.registerCommand(name, { description: i18n.t("commandDescription"), handler: handleCommand });
  }
}
