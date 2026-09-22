import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Workflow 运行时配置。
 *
 * 优先级：JSON 配置文件（由 /config:workflow 斜杠命令写入）> 环境变量兜底 > 默认值。
 * 环境变量仅作为兜底支持（PI_WORKFLOW_BACKEND / PI_WORKFLOW_ASYNC）。
 * 运行期（内存）用 `background` 表示异步模式，避免和 JS 关键字撞名；
 * 写盘的 JSON 里仍是历史字段名 `async`，不破坏已有用户配置。
 */
export type WorkflowBackend = "workflow" | "subagent";

export interface WorkflowConfig {
	/** 执行后端：内置 workflow agent 或 pi-interactive-subagents 子会话。 */
	backend: WorkflowBackend;
	/** 是否以后台异步模式运行 workflow（注册 workflow_cancel 工具）。 */
	background: boolean;
}

/** 未知字段和非法取值时的错误信息前缀，供调用方识别。 */
const CONFIG_FIELD_ERROR = "workflow configuration";

const DEFAULTS: WorkflowConfig = { backend: "workflow", background: false };

/** 配置文件路径：<agentDir>/extensions/pi-dynamic-workflows/config.json */
export function configPath(agentDir = getAgentDir()): string {
	return join(agentDir, "extensions", "pi-dynamic-workflows", "config.json");
}

/** 环境变量兜底值；没有对应环境变量时用默认值。 */
function fromEnv(): WorkflowConfig {
	const config = { ...DEFAULTS };
	if (process.env.PI_WORKFLOW_BACKEND === "subagent") config.backend = "subagent";
	if (process.env.PI_WORKFLOW_ASYNC === "true") config.background = true;
	return config;
}

/**
 * 校验一份配置对象，缺失字段走默认值，未知字段和非法取值直接报错。
 * 面板写回的值也会过这里，保证候选表和校验规则不会各走各的。
 */
export function parseConfig(value: unknown): WorkflowConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${CONFIG_FIELD_ERROR} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (key !== "backend" && key !== "background" && key !== "async") {
			throw new Error(`unknown ${CONFIG_FIELD_ERROR} field: ${key}`);
		}
	}
	if (raw.backend !== undefined && raw.backend !== "workflow" && raw.backend !== "subagent") {
		throw new Error(`${CONFIG_FIELD_ERROR}: backend must be one of: workflow, subagent`);
	}
	for (const key of ["background", "async"] as const) {
		if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
			throw new Error(`${CONFIG_FIELD_ERROR}: ${key} must be a boolean`);
		}
	}
	// 写盘的历史字段名是 `async`，这里接受两种写法。
	const background = (raw.background ?? raw.async) as boolean | undefined;
	return {
		backend: (raw.backend as WorkflowBackend | undefined) ?? DEFAULTS.backend,
		background: background ?? DEFAULTS.background,
	};
}

/** 读取配置：JSON 文件覆盖环境变量兜底值。文件缺失或损坏时静默回退到环境变量/默认值。 */
export function loadConfig(path = configPath()): WorkflowConfig {
	const config = fromEnv();
	try {
		if (!existsSync(path)) return config;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		if (parsed.backend === "workflow" || parsed.backend === "subagent") config.backend = parsed.backend;
		if (typeof parsed.background === "boolean") config.background = parsed.background;
		else if (typeof parsed.async === "boolean") config.background = parsed.async;
	} catch {
		// 配置损坏：保留环境变量兜底值，不抛出。
	}
	return config;
}

/** 合并写入配置，返回写入后的完整配置；运行期字段名 `background` 落盘时写成 `async`。 */
export function saveConfig(partial: Partial<WorkflowConfig>, path = configPath()): WorkflowConfig {
	const merged = parseConfig({ ...loadConfig(path), ...partial });
	const stored = { backend: merged.backend, async: merged.background };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, "utf-8");
	return merged;
}
