import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_DIRECTORY_NAME = "pi-nested-skills";
export const SKILL_ROOTS_ENV = "PI_NESTED_SKILLS_ROOTS";
export const LEGACY_SKILLS_DIR_ENV = "PI_NESTED_SKILLS_DIR";

export interface NestedSkillsConfig {
  /** 包含技能包目录的根目录列表。 */
  skillRoots: string[];
}

export type ConfigSource = "file" | "environment" | "default";

export interface LoadedNestedSkillsConfig {
  config: NestedSkillsConfig;
  source: ConfigSource;
  /** 配置文件或环境变量存在但无法使用时的明确诊断。 */
  warnings: string[];
  /** 是否由用户显式提供过根目录配置。 */
  explicit: boolean;
}

interface ConfigObject {
  skillRoots?: unknown;
  /** 早期试用版本使用的单数名称，读取时保留兼容性。 */
  skillsDir?: unknown;
}

/** 返回实际 Pi agent 目录下的扩展配置文件路径。 */
export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, "extensions", CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

/** 默认使用 Pi 的标准全局技能目录；需要兼容其他技能树时可通过配置覆盖。 */
export function defaultSkillRoots(agentDir = getAgentDir()): string[] {
  return [join(agentDir, "skills")];
}

function expandHomePath(value: string, homeDirectory = homedir()): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homeDirectory, value.slice(2));
  }
  return value;
}

/** 将配置中的绝对、~/ 和相对 Pi agent 目录路径统一为绝对路径。 */
export function resolveSkillRoot(
  value: string,
  agentDir: string,
  homeDirectory = homedir(),
): string {
  const expanded = expandHomePath(value.trim(), homeDirectory);
  return isAbsolute(expanded) ? expanded : resolve(agentDir, expanded);
}

function normalizeRootValues(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return undefined;

  const roots: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") return undefined;
    roots.push(item.trim());
  }
  return roots;
}

function readConfigFile(path: string): { value?: string[]; warning?: string } {
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ConfigObject;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { warning: `Invalid configuration object in ${path}.` };
    }

    const configured = parsed.skillRoots === undefined ? parsed.skillsDir : parsed.skillRoots;
    if (configured === undefined) return {};
    const roots = normalizeRootValues(configured);
    if (roots === undefined) {
      return { warning: `Configuration field "skillRoots" must be a string or an array of strings in ${path}.` };
    }
    return { value: roots };
  } catch (error) {
    return {
      warning: `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function environmentRoots(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env[SKILL_ROOTS_ENV] ?? env[LEGACY_SKILLS_DIR_ENV];
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * 读取技能根目录配置：配置文件 > 环境变量 > Pi 标准默认目录。
 * 相对路径以 agent 目录为基准，避免把当前工作目录或维护者机器路径写进配置。
 */
export function loadConfig(
  agentDir = getAgentDir(),
  env: NodeJS.ProcessEnv = process.env,
): LoadedNestedSkillsConfig {
  const path = configPath(agentDir);
  const fileResult = readConfigFile(path);
  const warnings = fileResult.warning ? [fileResult.warning] : [];

  if (fileResult.value !== undefined) {
    return {
      config: {
        skillRoots: fileResult.value.map((value) => resolveSkillRoot(value, agentDir)),
      },
      source: "file",
      warnings,
      explicit: true,
    };
  }

  const envValue = environmentRoots(env);
  if (envValue !== undefined) {
    return {
      config: {
        skillRoots: envValue.map((value) => resolveSkillRoot(value, agentDir)),
      },
      source: "environment",
      warnings,
      explicit: true,
    };
  }

  return {
    config: { skillRoots: defaultSkillRoots(agentDir) },
    source: "default",
    warnings,
    explicit: false,
  };
}
