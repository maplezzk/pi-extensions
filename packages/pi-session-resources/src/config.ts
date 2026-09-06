import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "pi-session-resources";
const CONFIG_FILE_NAME = "config.json";
const EXTENSIONS_DIRECTORY = "extensions";
const UTF8_ENCODING = "utf8";
const FILE_NOT_FOUND_CODE = "ENOENT";

export interface SessionResourcesConfig {
  enabled: boolean;
}

export const DEFAULT_SESSION_RESOURCES_CONFIG: SessionResourcesConfig = { enabled: true };

/** 返回会话资源选择器的配置文件路径。 */
export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, EXTENSIONS_DIRECTORY, PACKAGE_NAME, CONFIG_FILE_NAME);
}

/** 解析并校验会话资源选择器配置。 */
export function parseConfig(value: unknown): SessionResourcesConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "enabled") throw new Error(`unknown configuration field: ${key}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  return { enabled: raw.enabled ?? DEFAULT_SESSION_RESOURCES_CONFIG.enabled };
}

/** 读取配置文件；缺少文件时使用默认启用状态。 */
export function loadConfig(path = configPath()): SessionResourcesConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, UTF8_ENCODING)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return { ...DEFAULT_SESSION_RESOURCES_CONFIG };
    throw error;
  }
}

/** 将经过校验的配置写入配置文件。 */
export function saveConfig(config: SessionResourcesConfig, path = configPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, UTF8_ENCODING);
  return path;
}
