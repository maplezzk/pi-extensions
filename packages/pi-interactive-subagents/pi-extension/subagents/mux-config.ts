import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MuxBackend } from "pi-terminal-mux";

export type SubagentMuxPreference = "auto" | MuxBackend;
export type SubagentMuxConfigSource = "environment" | "file" | "default";
export const HERDR_SURFACE_MODE_SPLIT = "split";
export const HERDR_SURFACE_MODE_TAB = "tab";
export const HERDR_SURFACE_MODES = [HERDR_SURFACE_MODE_SPLIT, HERDR_SURFACE_MODE_TAB] as const;
export type HerdrSurfaceMode = (typeof HERDR_SURFACE_MODES)[number];

export interface SubagentMuxConfig {
  mux: SubagentMuxPreference;
  source: SubagentMuxConfigSource;
}

export interface SubagentHerdrModeConfig {
  herdrMode: HerdrSurfaceMode;
  source: SubagentMuxConfigSource;
}

const BACKENDS: readonly MuxBackend[] = ["muxy", "cmux", "tmux", "zellij", "wezterm", "herdr", "otty", "orca"];
const CONFIG_FILE = "config.json";
const HERDR_MODE_ENV = "PI_SUBAGENT_HERDR_MODE";
const DEFAULT_HERDR_MODE: HerdrSurfaceMode = HERDR_SURFACE_MODE_SPLIT;

function isMuxBackend(value: unknown): value is MuxBackend {
  return typeof value === "string" && (BACKENDS as readonly string[]).includes(value);
}

function normalizePreference(value: unknown): SubagentMuxPreference | null {
  if (value === "auto") return "auto";
  return isMuxBackend(value) ? value : null;
}

/** 将未知配置值收窄为受支持的 Herdr surface 模式。 */
function normalizeHerdrMode(value: unknown): HerdrSurfaceMode | null {
  return typeof value === "string" && (HERDR_SURFACE_MODES as readonly string[]).includes(value)
    ? value as HerdrSurfaceMode
    : null;
}

function environmentPreference(): MuxBackend | null {
  const value = (process.env.PI_TERMINAL_MUX ?? process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  return isMuxBackend(value) ? value : null;
}

/** 读取有效的 Herdr 模式环境变量；非法值留给 pi-terminal-mux 显式报错。 */
function environmentHerdrMode(): HerdrSurfaceMode | null {
  return normalizeHerdrMode(process.env[HERDR_MODE_ENV]?.trim().toLowerCase());
}

/** 判断用户是否显式提供了非空 Herdr 模式环境变量，包括待报错的非法值。 */
function hasHerdrModeEnvironmentOverride(): boolean {
  return !!process.env[HERDR_MODE_ENV]?.trim();
}

/** User-level config shared by the subagent extension across Pi sessions. */
export function muxConfigPath(): string {
  return join(getAgentDir(), "extensions", "pi-interactive-subagents", CONFIG_FILE);
}

/** 读取配置对象；不存在、格式错误或非对象时返回空对象。 */
function readConfigObject(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** 写入完整配置对象并保留稳定的格式与结尾换行。 */
function writeConfigObject(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function readStoredPreference(path: string): SubagentMuxPreference | null {
  return normalizePreference(readConfigObject(path).mux);
}

/** 读取持久化 Herdr 模式；旧配置缺少字段时返回 null。 */
function readStoredHerdrMode(path: string): HerdrSurfaceMode | null {
  return normalizeHerdrMode(readConfigObject(path).herdrMode);
}

/** Environment variables override the persisted slash-command setting. */
export function loadMuxConfig(path = muxConfigPath()): SubagentMuxConfig {
  const env = environmentPreference();
  if (env) return { mux: env, source: "environment" };

  const stored = readStoredPreference(path);
  if (stored) return { mux: stored, source: "file" };

  return { mux: "auto", source: "default" };
}

/** Herdr mode environment variables override the persisted setting; default stays split. */
export function loadHerdrModeConfig(path = muxConfigPath()): SubagentHerdrModeConfig {
  const env = environmentHerdrMode();
  if (env) return { herdrMode: env, source: "environment" };

  const stored = readStoredHerdrMode(path);
  if (stored) return { herdrMode: stored, source: "file" };

  return { herdrMode: DEFAULT_HERDR_MODE, source: "default" };
}

/** Apply persisted mux and Herdr mode settings when no explicit environment override exists. */
export function applyPersistedMuxPreference(path = muxConfigPath()): void {
  if (!environmentPreference()) {
    const preference = readStoredPreference(path);
    if (preference && preference !== "auto") {
      process.env.PI_TERMINAL_MUX = preference;
    }
  }

  if (!hasHerdrModeEnvironmentOverride()) {
    const herdrMode = readStoredHerdrMode(path);
    if (herdrMode) process.env[HERDR_MODE_ENV] = herdrMode;
  }
}

/** Persist a slash-command selection and make it effective immediately. */
export function saveMuxPreference(preference: SubagentMuxPreference, path = muxConfigPath()): SubagentMuxConfig {
  const normalized = normalizePreference(preference);
  if (!normalized) throw new Error(`Unsupported subagent mux preference: ${String(preference)}`);

  writeConfigObject(path, { ...readConfigObject(path), mux: normalized });

  if (normalized === "auto") {
    delete process.env.PI_TERMINAL_MUX;
    delete process.env.PI_SUBAGENT_MUX;
  } else {
    process.env.PI_TERMINAL_MUX = normalized;
    delete process.env.PI_SUBAGENT_MUX;
  }

  return { mux: normalized, source: "file" };
}

/** Persist a Herdr split/tab selection and make it effective immediately. */
export function saveHerdrMode(mode: HerdrSurfaceMode, path = muxConfigPath()): SubagentHerdrModeConfig {
  const normalized = normalizeHerdrMode(mode);
  if (!normalized) throw new Error(`Unsupported Herdr surface mode: ${String(mode)}`);

  writeConfigObject(path, { ...readConfigObject(path), herdrMode: normalized });
  process.env[HERDR_MODE_ENV] = normalized;
  return { herdrMode: normalized, source: "file" };
}

export { BACKENDS as SUBAGENT_MUX_BACKENDS };
