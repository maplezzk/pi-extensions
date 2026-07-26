import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MuxBackend } from "pi-terminal-mux";

export type SubagentMuxPreference = "auto" | MuxBackend;
export type SubagentMuxConfigSource = "environment" | "file" | "default";

export interface SubagentMuxConfig {
  mux: SubagentMuxPreference;
  source: SubagentMuxConfigSource;
}

const BACKENDS: readonly MuxBackend[] = ["muxy", "cmux", "tmux", "zellij", "wezterm", "herdr", "otty"];
const CONFIG_FILE = "config.json";

function isMuxBackend(value: unknown): value is MuxBackend {
  return typeof value === "string" && (BACKENDS as readonly string[]).includes(value);
}

function normalizePreference(value: unknown): SubagentMuxPreference | null {
  if (value === "auto") return "auto";
  return isMuxBackend(value) ? value : null;
}

function environmentPreference(): MuxBackend | null {
  const value = (process.env.PI_TERMINAL_MUX ?? process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  return isMuxBackend(value) ? value : null;
}

/** User-level config shared by the subagent extension across Pi sessions. */
export function muxConfigPath(): string {
  return join(getAgentDir(), "extensions", "pi-interactive-subagents", CONFIG_FILE);
}

function readStoredPreference(path: string): SubagentMuxPreference | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { mux?: unknown };
    return normalizePreference(parsed.mux);
  } catch {
    return null;
  }
}

/** Environment variables override the persisted slash-command setting. */
export function loadMuxConfig(path = muxConfigPath()): SubagentMuxConfig {
  const env = environmentPreference();
  if (env) return { mux: env, source: "environment" };

  const stored = readStoredPreference(path);
  if (stored) return { mux: stored, source: "file" };

  return { mux: "auto", source: "default" };
}

/** Apply the persisted setting when no explicit environment override exists. */
export function applyPersistedMuxPreference(path = muxConfigPath()): void {
  if (environmentPreference()) return;
  const preference = readStoredPreference(path);
  if (!preference || preference === "auto") return;
  process.env.PI_TERMINAL_MUX = preference;
}

/** Persist a slash-command selection and make it effective immediately. */
export function saveMuxPreference(preference: SubagentMuxPreference, path = muxConfigPath()): SubagentMuxConfig {
  const normalized = normalizePreference(preference);
  if (!normalized) throw new Error(`Unsupported subagent mux preference: ${String(preference)}`);

  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // A malformed file is replaced with a valid config by this explicit save.
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...existing, mux: normalized }, null, 2)}\n`, "utf-8");

  if (normalized === "auto") {
    delete process.env.PI_TERMINAL_MUX;
    delete process.env.PI_SUBAGENT_MUX;
  } else {
    process.env.PI_TERMINAL_MUX = normalized;
    delete process.env.PI_SUBAGENT_MUX;
  }

  return { mux: normalized, source: "file" };
}

export { BACKENDS as SUBAGENT_MUX_BACKENDS };
