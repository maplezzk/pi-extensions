import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_DIRECTORY_NAME = "pi-nested-skills";

export interface NestedSkillsConfig {
  /** 包含技能包目录的根目录列表。 */
  skillRoots: string[];
}

export type ConfigSource = "file" | "default";

export interface LoadedNestedSkillsConfig {
  config: NestedSkillsConfig;
  source: ConfigSource;
  /** 配置文件存在但无法使用时的明确诊断。 */
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

/** 校验配置命令提交的 JSON，并保留早期配置文件的 skillsDir 兼容字段。 */
export function parseConfig(value: unknown): NestedSkillsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be an object");
  }
  const raw = value as ConfigObject;
  const configured = raw.skillRoots === undefined ? raw.skillsDir : raw.skillRoots;
  const roots = normalizeRootValues(configured);
  if (roots === undefined) {
    throw new Error('configuration field "skillRoots" must be a string or an array of strings');
  }
  return { skillRoots: roots };
}

/** 读取配置文件并返回规范化前的根目录值或明确诊断。 */
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

/** 将技能根目录配置写入 Pi agent 配置目录。 */
export function saveConfig(config: NestedSkillsConfig, agentDir = getAgentDir()): string {
  const path = configPath(agentDir);
  mkdirSync(join(agentDir, "extensions", CONFIG_DIRECTORY_NAME), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

/** 读取技能根目录配置：配置文件 > Pi 标准默认目录。 */
export function loadConfig(agentDir = getAgentDir()): LoadedNestedSkillsConfig {
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

  return {
    config: { skillRoots: defaultSkillRoots(agentDir) },
    source: "default",
    warnings,
    explicit: false,
  };
}
