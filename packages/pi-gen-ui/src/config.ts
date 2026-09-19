import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./agent-dir.ts";

/** When the interactive panel opens. */
export type InteractiveViewMode = "auto" | "always" | "never";

/** Catalog-constrained composition settings (experimental upstream API). */
export interface CompositionConfig {
  /** Whether the compose_ui tool is available at all. */
  enabled: boolean;
  /** Gateway evaluation model id. */
  model: string;
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
    model: "typesafe-ai/jev",
    timeoutMs: 10000,
  },
};

const VIEW_MODES: readonly InteractiveViewMode[] = ["auto", "always", "never"];

/** Clamp a numeric field into a safe range, falling back on invalid input. */
function clampNumber(options: { value: unknown; fallback: number; min: number; max: number }): number {
  return typeof options.value === "number" && Number.isFinite(options.value)
    ? Math.max(options.min, Math.min(options.max, Math.floor(options.value)))
    : options.fallback;
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
      model:
        typeof compositionRaw.model === "string" && compositionRaw.model.trim().length > 0
          ? compositionRaw.model.trim()
          : DEFAULT_CONFIG.composition.model,
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
