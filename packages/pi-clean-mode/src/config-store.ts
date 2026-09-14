import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_CLEAN_MODE_CONFIG,
	type CleanModeConfig,
	type ConfigLoadResult,
	type ConfigSaveResult,
} from "./types.js";

const CONFIG_DIRECTORY_NAME = "pi-clean-mode";
const CONFIG_FILE_NAME = "config.json";

/** 返回当前 Pi agent 目录下的清爽模式配置路径。 */
export function configPath(): string {
	return join(getAgentDir(), "extensions", CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

/** 判断输入是否为可按键读取的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 把配置项收窄成布尔值；字段缺失或类型不符时回落到默认值。 */
function toBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** 把任意输入正规化成完整配置，缺字段一律补默认值。 */
export function normalizeConfig(raw: unknown): CleanModeConfig {
	const record: Record<string, unknown> = isRecord(raw) ? raw : {};
	return {
		enabled: toBoolean(record.enabled, DEFAULT_CLEAN_MODE_CONFIG.enabled),
		autoExpandWhileRunning: toBoolean(
			record.autoExpandWhileRunning,
			DEFAULT_CLEAN_MODE_CONFIG.autoExpandWhileRunning,
		),
		showRunHeader: toBoolean(record.showRunHeader, DEFAULT_CLEAN_MODE_CONFIG.showRunHeader),
		showExpandHint: toBoolean(record.showExpandHint, DEFAULT_CLEAN_MODE_CONFIG.showExpandHint),
	};
}

/** 读取配置；文件缺失时返回默认配置，解析失败时附带诊断信息。 */
export function loadConfig(path = configPath()): ConfigLoadResult {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return { config: { ...DEFAULT_CLEAN_MODE_CONFIG } };
	}

	try {
		return { config: normalizeConfig(JSON.parse(content)) };
	} catch (error) {
		return {
			config: { ...DEFAULT_CLEAN_MODE_CONFIG },
			diagnostic: error instanceof Error ? error.message : String(error),
		};
	}
}

/** 写入配置；失败时返回错误信息而不抛出，交由调用方提示。 */
export function saveConfig(config: CleanModeConfig, path = configPath()): ConfigSaveResult {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
		return { success: true };
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : String(error) };
	}
}
