import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { i18n } from "./i18n.ts";

const EXTENSIONS_DIR = "extensions";
const PACKAGE_NAME = "pi-naming";
const CONFIG_FILENAME = "config.json";
const FILE_NOT_FOUND_CODE = "ENOENT";
const NAMING_SWITCHES = ["automaticNaming", "workspaceRename", "tabRename"] as const;

export interface NamingConfig {
  automaticNaming: boolean;
  workspaceRename: boolean;
  tabRename: boolean;
}

/** 三项命名能力独立开关，未指定时保留默认行为。 */
export function parseConfig(value: unknown): NamingConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(i18n.t("namingConfigInvalid"));
  }
  const raw = value as Record<string, unknown>;
  for (const key of NAMING_SWITCHES) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new Error(i18n.t("namingConfigInvalid"));
    }
  }
  return {
    automaticNaming: (raw.automaticNaming as boolean | undefined) ?? true,
    workspaceRename: (raw.workspaceRename as boolean | undefined) ?? true,
    tabRename: (raw.tabRename as boolean | undefined) ?? true,
  };
}

/** 仅缺少配置文件时采用默认值，读取和解析错误交给入口报告。 */
export function loadConfig(
  path = join(getAgentDir(), EXTENSIONS_DIR, PACKAGE_NAME, CONFIG_FILENAME),
): NamingConfig {
  try {
    const raw = readFileSync(path, "utf8");
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return parseConfig({});
    throw error;
  }
}
