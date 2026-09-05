import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveJavaSkill } from "./config-utils.ts";
import { i18n } from "./i18n.ts";

export interface SafetyConfig {
  dangerCommands: boolean;
  bashDirectoryScope: boolean;
  maven: boolean;
  javaSkill: string;
}

const EXTENSIONS_DIR = "extensions";
const PACKAGE_NAME = "pi-safety-guards";
const CONFIG_FILENAME = "config.json";
const DEFAULT_JAVA_SKILL = "java-build";

/** 返回 Pi agent 目录下本包的配置路径。 */
export function configPath(): string {
  return join(getAgentDir(), EXTENSIONS_DIR, PACKAGE_NAME, CONFIG_FILENAME);
}

/** 配置损坏不能静默关闭安全门；交给入口阻断并提示修复。 */
export function parseConfig(value: unknown, envSkill = process.env.PI_JAVA_SKILL): SafetyConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(i18n.t("configObjectRequired"));
  }
  const raw = value as Record<string, unknown>;
  for (const key of ["dangerCommands", "bashDirectoryScope", "maven"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new Error(i18n.t("configBooleanRequired", { key }));
    }
  }
  if (raw.javaSkill !== undefined && (typeof raw.javaSkill !== "string" || !raw.javaSkill.trim())) {
    throw new Error(i18n.t("configSkillRequired"));
  }
  return {
    dangerCommands: raw.dangerCommands as boolean | undefined ?? true,
    bashDirectoryScope: raw.bashDirectoryScope as boolean | undefined ?? true,
    maven: raw.maven as boolean | undefined ?? true,
    javaSkill: resolveJavaSkill(raw.javaSkill as string | undefined, envSkill, DEFAULT_JAVA_SKILL),
  };
}

/** 仅文件不存在使用默认值；读取和解析错误必须显式报告。 */
export function loadConfig(path = configPath()): SafetyConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
    throw error;
  }
  return parseConfig(JSON.parse(raw));
}
