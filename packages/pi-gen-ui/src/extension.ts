import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installNoticeRenderer, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";
import { catalogDocPath, configPath } from "./agent-dir.ts";
import {
	COMPOSITION_PROVIDERS,
	DEFAULT_CONFIG,
	loadConfig,
	saveConfig,
	withComposition,
	type CompositionProvider,
	type JsonRenderConfig,
} from "./config.ts";
import { renderCatalogDoc } from "./catalog-doc.ts";
import {
	compositionAvailability,
	coreSupportsComposition,
	resolveComposition,
	type CompositionAvailability,
} from "./compose.ts";
import { createComposeUiTool } from "./compose-tool.ts";
import { openConfigPanel } from "./config-panel.ts";
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

/** Actions the command accepts; a bare command opens the panel instead. */
const COMMAND_ACTIONS = [
	"enable",
	"disable",
	"status",
	"reset",
	"provider",
	"model",
	"composition",
	"catalog",
] as const;
type CommandAction = (typeof COMMAND_ACTIONS)[number];

/** Argument completions offered after `/config:gen-ui `. */
const COMMAND_ARGUMENTS: readonly string[] = [
	"enable",
	"disable",
	"status",
	"reset",
	"catalog",
	"composition on",
	"composition off",
	"model default",
	...COMPOSITION_PROVIDERS.map((provider) => `provider ${provider}`),
];

/** Values the `composition` argument accepts for each state. */
const COMPOSITION_ON_VALUES: readonly string[] = ["on", "true", "enable", "enabled"];
const COMPOSITION_OFF_VALUES: readonly string[] = ["off", "false", "disable", "disabled"];

/** Model argument value that restores the channel default. */
const MODEL_DEFAULT_VALUE = "default";

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
  return resolved ? `${resolved.provider} (${resolved.keyEnv}, ${resolved.model})` : "available";
}

/** Error text for notices, so a thrown non-Error still reports something usable. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register the render_ui tool, the optional compose_ui tool, and the configuration command.
 *
 * Whether the installed `@json-render/core` still exports the experimental composer is the one
 * gate that cannot change while the session runs, so it alone decides registration. Every other
 * gate (master switch, composition switch, transport and key) is evaluated per call, which is
 * what lets the configuration panel and the command take effect immediately without a reload.
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

  const coreSupports = await coreSupportsComposition();
  /** Current composition availability under the live configuration. */
  const availability = (): CompositionAvailability =>
    compositionAvailability({ config, coreSupportsComposition: coreSupports });

  pi.registerTool(createRenderUiTool({ getConfig: () => config }));
  if (coreSupports) {
    pi.registerTool(createComposeUiTool({ getConfig: () => config, getAvailability: availability }));
  }

  pi.on("session_start", (_event, ctx) => {
    if (configError !== undefined) {
      notify(
        ctx,
        i18n.t("configLoadFailed", {
          path: configPath(),
          error: errorText(configError),
        }),
        "warning",
      );
      configError = undefined;
    }

    // Only speak up when the user asked for composition and something blocks it;
    // an explicitly disabled composer needs no session-start noise.
    const current = availability();
    if (!current.available && current.reason !== "disabled") {
      notify(
        ctx,
        i18n.t(current.reason === "unsupportedCore" ? "composeUnsupportedCore" : "composeMissingKey"),
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
          error: errorText(error),
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
        state: i18n.t(config.enabled ? "configOn" : "configOff"),
        maxLines: config.maxResultLines,
        view: config.interactiveView,
        composition: compositionState(availability(), config),
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
          error: errorText(error),
        }),
        "error",
      );
    }
  }

  /** Open the TUI panel bound to the live configuration and the available models. */
  async function openPanel(ctx: ExtensionCommandContext): Promise<void> {
    await openConfigPanel(ctx, {
      getConfig: () => config,
      getModels: () => ctx.modelRegistry.getAvailable(),
      onChange: (next) => applyConfig(ctx, next),
    });
  }

  /** Change the transport. */
  function setProvider(value: string, ctx: ExtensionCommandContext): void {
    if (!(COMPOSITION_PROVIDERS as readonly string[]).includes(value)) {
      notify(ctx, i18n.t("commandUsage"), "warning");
      return;
    }
    applyConfig(ctx, withComposition(config, { provider: value as CompositionProvider }));
    notify(ctx, i18n.t("providerSet", { provider: value }), "info");
  }

  /** Change the evaluation model; `default` restores the transport default. */
  function setModel(value: string, ctx: ExtensionCommandContext): void {
    if (!value) {
      notify(ctx, i18n.t("commandUsage"), "warning");
      return;
    }
    const isDefault = value === MODEL_DEFAULT_VALUE;
    applyConfig(ctx, withComposition(config, { model: isDefault ? "" : value }));
    notify(
      ctx,
      i18n.t("modelSet", { model: isDefault ? i18n.t("configModelChannelDefault") : value }),
      "info",
    );
  }

  /** Turn composition on or off. */
  function setComposition(value: string, ctx: ExtensionCommandContext): void {
    const on = COMPOSITION_ON_VALUES.includes(value);
    const off = COMPOSITION_OFF_VALUES.includes(value);
    if (!on && !off) {
      notify(ctx, i18n.t("commandUsage"), "warning");
      return;
    }
    applyConfig(ctx, withComposition(config, { enabled: on }));
    notify(ctx, i18n.t("compositionSet", { state: i18n.t(on ? "configOn" : "configOff") }), "info");
  }

  /** Rewrite the component reference and report the outcome. */
  function writeCatalog(ctx: ExtensionCommandContext): void {
    try {
      notify(ctx, i18n.t("catalogWritten", { path: writeCatalogReference() }), "info");
    } catch (error) {
      notify(
        ctx,
        i18n.t("catalogCommandFailed", { path: catalogDocPath(), error: errorText(error) }),
        "error",
      );
    }
  }

  /** Handle the master switch. */
  function setEnabled(enabled: boolean, ctx: ExtensionCommandContext): void {
    applyConfig(ctx, { ...config, enabled });
    notify(ctx, i18n.t(enabled ? "enabled" : "disabled"), "info");
  }

  /** Restore defaults. */
  function resetConfig(ctx: ExtensionCommandContext): void {
    applyConfig(ctx, { ...DEFAULT_CONFIG, composition: { ...DEFAULT_CONFIG.composition } });
    notify(ctx, i18n.t("configReset"), "info");
  }

  /** Open the panel for a bare command, or run one action with its argument. */
  async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    const trimmed = rawArgs.trim();
    if (!trimmed) {
      await openPanel(ctx);
      return;
    }
    const parts = trimmed.split(/\s+/);
    const action = parts[0] ?? "";
    const rest = parts.slice(1).join(" ").trim();
    if (!(COMMAND_ACTIONS as readonly string[]).includes(action)) {
      notify(ctx, i18n.t("commandUsage"), "warning");
      return;
    }
    switch (action as CommandAction) {
      case "enable":
        setEnabled(true, ctx);
        return;
      case "disable":
        setEnabled(false, ctx);
        return;
      case "status":
        reportStatus(ctx);
        return;
      case "reset":
        resetConfig(ctx);
        return;
      case "provider":
        setProvider(rest, ctx);
        return;
      case "model":
        setModel(rest, ctx);
        return;
      case "composition":
        setComposition(rest, ctx);
        return;
      case "catalog":
        writeCatalog(ctx);
        return;
    }
  }

  for (const name of COMMAND_NAMES) {
    pi.registerCommand(name, {
      description: i18n.t("commandDescription"),
      getArgumentCompletions: () => COMMAND_ARGUMENTS.map((value) => ({ value, label: value })),
      handler: handleCommand,
    });
  }
}
