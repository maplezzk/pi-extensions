import type {
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { parse, type ParsedScript } from "unbash";
import { resolveRulesFilePath } from "./review-utils.ts";

const CONDITION_CACHE_QUERY = "piToolSupervisorCondition";
const CONDITION_RETURN_ERROR = "Condition module must return a boolean";
const CONDITION_TIMEOUT_ERROR = "Condition module timed out";
export const CONDITION_MATCHED_STATUS = "matched" as const;
export const CONDITION_NOT_MATCHED_STATUS = "not-matched" as const;
export const CONDITION_ERROR_STATUS = "error" as const;

export type ToolConditionEvent = ToolCallEvent | ToolResultEvent;

/** Helpers exposed to condition modules without requiring them to resolve supervisor dependencies. */
export interface ToolConditionHelpers {
  /** Parses Bash without executing it, returning the tolerant AST and parse errors. */
  parseBash(source: string): ParsedScript;
}

/** A configured condition receives the native Pi event and extension context unchanged. */
export type ToolCondition = (
  event: ToolConditionEvent,
  ctx: ExtensionContext,
  helpers: ToolConditionHelpers,
) => boolean | Promise<boolean>;

export interface ToolConditionEvaluation {
  status: typeof CONDITION_MATCHED_STATUS | typeof CONDITION_NOT_MATCHED_STATUS | typeof CONDITION_ERROR_STATUS;
  path?: string;
  durationMs: number;
  error?: string;
}

interface ConditionModuleCacheEntry {
  fingerprint: string;
  condition: ToolCondition;
}

interface EvaluateConditionOptions {
  conditionPath?: string;
  cwd: string;
  event: ToolConditionEvent;
  ctx: ExtensionContext;
  timeoutMs: number;
}

interface InvokeConditionOptions {
  condition: ToolCondition;
  event: ToolConditionEvent;
  ctx: ExtensionContext;
  timeoutMs: number;
}

const conditionModuleCache = new Map<string, ConditionModuleCacheEntry>();
const conditionHelpers: ToolConditionHelpers = Object.freeze({ parseBash: parse });

/** Loads and executes a configured condition module, returning an explicit evaluation state. */
export async function evaluateToolCondition(
  options: EvaluateConditionOptions,
): Promise<ToolConditionEvaluation> {
  if (!options.conditionPath) {
    return { status: CONDITION_MATCHED_STATUS, durationMs: 0 };
  }

  const startedAt = performance.now();
  const absolutePath = resolveRulesFilePath(options.conditionPath, options.cwd);
  try {
    const condition = await loadConditionModule(absolutePath);
    const matched = await invokeCondition({
      condition,
      event: options.event,
      ctx: options.ctx,
      timeoutMs: options.timeoutMs,
    });
    return {
      status: matched ? CONDITION_MATCHED_STATUS : CONDITION_NOT_MATCHED_STATUS,
      path: absolutePath,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      status: CONDITION_ERROR_STATUS,
      path: absolutePath,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Resolves a condition module and reloads it when its file fingerprint changes. */
async function loadConditionModule(absolutePath: string): Promise<ToolCondition> {
  const stats = statSync(absolutePath);
  if (!stats.isFile()) throw new Error("Condition module path is not a file");

  const fingerprint = `${stats.mtimeMs}:${stats.size}`;
  const cached = conditionModuleCache.get(absolutePath);
  if (cached?.fingerprint === fingerprint) return cached.condition;

  const moduleUrl = `${pathToFileURL(absolutePath).href}?${CONDITION_CACHE_QUERY}=${encodeURIComponent(fingerprint)}`;
  const loaded: unknown = await tsImport(moduleUrl, import.meta.url);
  const candidate = getConditionExport(loaded);
  if (typeof candidate !== "function") throw new Error("Condition module must export a default function");

  const condition = candidate as ToolCondition;
  conditionModuleCache.set(absolutePath, { fingerprint, condition });
  return condition;
}

/** Executes a condition with the configured timeout while preserving the native callback arguments. */
async function invokeCondition(options: InvokeConditionOptions): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => options.condition(options.event, options.ctx, conditionHelpers)),
      new Promise<boolean>((_, reject) => {
        timer = setTimeout(() => reject(new Error(CONDITION_TIMEOUT_ERROR)), options.timeoutMs);
      }),
    ]);
    if (typeof result !== "boolean") throw new Error(CONDITION_RETURN_ERROR);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Reads the default function across native ESM and TypeScript CJS interop shapes. */
function getConditionExport(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const candidates = [value.default, value["module.exports"]];
  for (const candidate of candidates) {
    if (typeof candidate === "function") return candidate;
    if (isRecord(candidate) && typeof candidate.default === "function") return candidate.default;
  }
  return undefined;
}

/** Narrows an unknown module namespace to a record before reading its default export. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
