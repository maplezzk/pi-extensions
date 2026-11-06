import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXTENSIONS_DIRECTORY = "extensions";
const PACKAGE_NAME = "pi-metrics";
const CONFIG_FILE_NAME = "config.json";
const UTF8_ENCODING = "utf8";
const FILE_NOT_FOUND_CODE = "ENOENT";

/** 指标显示时机：live 每轮一行；on-stop 只在整段运行停下后汇总一行。 */
export type MetricsDisplay = "live" | "on-stop";

const DISPLAY_VALUES: readonly MetricsDisplay[] = ["live", "on-stop"];

export interface MetricsConfig {
  enabled: boolean;
  display: MetricsDisplay;
}

export const DEFAULT_METRICS_CONFIG: MetricsConfig = { enabled: true, display: "on-stop" };

/** 返回 pi-metrics 配置文件路径。 */
export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, EXTENSIONS_DIRECTORY, PACKAGE_NAME, CONFIG_FILE_NAME);
}

/** 解析并校验 pi-metrics 配置。 */
export function parseConfig(value: unknown): MetricsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration must be an object");
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "enabled" && key !== "display") throw new Error(`unknown configuration field: ${key}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (raw.display !== undefined && !DISPLAY_VALUES.includes(raw.display as MetricsDisplay)) {
    throw new Error(`display must be one of: ${DISPLAY_VALUES.join(", ")}`);
  }
  return {
    enabled: (raw.enabled as boolean | undefined) ?? DEFAULT_METRICS_CONFIG.enabled,
    display: (raw.display as MetricsDisplay | undefined) ?? DEFAULT_METRICS_CONFIG.display,
  };
}

/** 读取配置文件；缺少文件时使用默认启用状态。 */
export function loadConfig(path = configPath()): MetricsConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(path, UTF8_ENCODING)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return { ...DEFAULT_METRICS_CONFIG };
    throw error;
  }
}

/** 将经过校验的配置写入配置文件。 */
export function saveConfig(config: MetricsConfig, path = configPath()): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, UTF8_ENCODING);
  return path;
}
