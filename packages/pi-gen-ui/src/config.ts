import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./agent-dir.ts";

/** When the interactive panel opens. */
export type InteractiveViewMode = "auto" | "always" | "never";

/** Evaluation transport used by `compose_ui`. */
export type CompositionProvider = "gateway" | "typesafe" | "auto";

/** Concrete providers (everything except the `auto` selector). */
export type ConcreteCompositionProvider = Exclude<CompositionProvider, "auto">;

/** Per-provider key variable and model defaults. */
export const PROVIDER_DEFAULTS: Record<ConcreteCompositionProvider, { keyEnv: string; model: string }> = {
  gateway: { keyEnv: "AI_GATEWAY_API_KEY", model: "typesafe-ai/jev" },
  typesafe: { keyEnv: "TYPESAFE_API_KEY", model: "jev-latest" },
};

/** Catalog-constrained composition settings (experimental upstream API). */
export interface CompositionConfig {
  /** Whether the compose_ui tool is available at all. */
  enabled: boolean;
  /**
   * Which evaluation transport to use.
   *
   * `gateway` posts to Vercel AI Gateway through core's built-in evaluator.
   * `typesafe` posts to TypeSafe's own endpoint through the local adapter.
   * `auto` picks whichever provider has a usable API key, preferring TypeSafe.
   */
  provider: CompositionProvider;
  /** Evaluation model id; an empty string uses the resolved provider's default. */
  model: string;
  /** Environment variable holding the API key; empty uses the resolved provider's default. */
  apiKeyEnv: string;
  /** Endpoint override for the TypeSafe transport; empty uses the TypeSafe default. */
  endpoint: string;
  /** Per-evaluation timeout in milliseconds. */
  timeoutMs: number;
}

/** Package configuration. */
export interface JsonRenderConfig {
  /** Whether the render_ui tool renders panels. */
  enabled: boolean;
  /** Maximum transcript lines a tool result renders before collapsing. */
  maxResultLines: number;
  /** Whether to open the keyboard-interactive panel. */
  interactiveView: InteractiveViewMode;
  /** Composition through a TypeSafe decision model. */
  composition: CompositionConfig;
}

/** Defaults, matching config.example.json. */
export const DEFAULT_CONFIG: JsonRenderConfig = {
  enabled: true,
  maxResultLines: 60,
  interactiveView: "auto",
  composition: {
    enabled: true,
    provider: "auto",
    model: "",
    apiKeyEnv: "",
    endpoint: "",
    timeoutMs: 10000,
  },
};

const VIEW_MODES: readonly InteractiveViewMode[] = ["auto", "always", "never"];
/** Transports the configuration accepts; the panel and the command validate against it. */
export const COMPOSITION_PROVIDERS: readonly CompositionProvider[] = ["gateway", "typesafe", "auto"];

/** Return a copy with the selected composition fields replaced. */
export function withComposition(
	config: JsonRenderConfig,
	patch: Partial<CompositionConfig>,
): JsonRenderConfig {
	return { ...config, composition: { ...config.composition, ...patch } };
}

/** Clamp a numeric field into a safe range, falling back on invalid input. */
function clampNumber(options: { value: unknown; fallback: number; min: number; max: number }): number {
  return typeof options.value === "number" && Number.isFinite(options.value)
    ? Math.max(options.min, Math.min(options.max, Math.floor(options.value)))
    : options.fallback;
}

/** Trim a string field, falling back when the value is not a usable string. */
function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** Coerce an unknown value into a valid configuration, ignoring bad fields. */
export function normalizeConfig(raw: unknown): JsonRenderConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_CONFIG, composition: { ...DEFAULT_CONFIG.composition } };
  }
  const record = raw as Record<string, unknown>;
  const compositionRaw =
    record.composition && typeof record.composition === "object" && !Array.isArray(record.composition)
      ? (record.composition as Record<string, unknown>)
      : {};

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_CONFIG.enabled,
    maxResultLines: clampNumber({
      value: record.maxResultLines,
      fallback: DEFAULT_CONFIG.maxResultLines,
      min: 5,
      max: 500,
    }),
    interactiveView:
      typeof record.interactiveView === "string" && (VIEW_MODES as readonly string[]).includes(record.interactiveView)
        ? (record.interactiveView as InteractiveViewMode)
        : DEFAULT_CONFIG.interactiveView,
    composition: {
      enabled:
        typeof compositionRaw.enabled === "boolean"
          ? compositionRaw.enabled
          : DEFAULT_CONFIG.composition.enabled,
      provider:
        typeof compositionRaw.provider === "string" && (COMPOSITION_PROVIDERS as readonly string[]).includes(compositionRaw.provider)
          ? (compositionRaw.provider as CompositionProvider)
          : DEFAULT_CONFIG.composition.provider,
      model: optionalString(compositionRaw.model, DEFAULT_CONFIG.composition.model),
      apiKeyEnv: optionalString(compositionRaw.apiKeyEnv, DEFAULT_CONFIG.composition.apiKeyEnv),
      endpoint: optionalString(compositionRaw.endpoint, DEFAULT_CONFIG.composition.endpoint),
      timeoutMs: clampNumber({
        value: compositionRaw.timeoutMs,
        fallback: DEFAULT_CONFIG.composition.timeoutMs,
        min: 500,
        max: 120000,
      }),
    },
  };
}

/** Read the configuration file; missing files fall back to defaults. */
export function loadConfig(): JsonRenderConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath(), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ...DEFAULT_CONFIG, composition: { ...DEFAULT_CONFIG.composition } };
    }
    throw error;
  }
}

/** Persist the configuration and return the written path. */
export function saveConfig(config: JsonRenderConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
  return path;
}
