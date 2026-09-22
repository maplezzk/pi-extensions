import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Workflow 运行时配置。
 *
 * 优先级：JSON 配置文件（由 /config:workflow 斜杠命令写入）> 环境变量兜底 > 默认值。
 * 环境变量仅作为兜底支持（PI_WORKFLOW_BACKEND / PI_WORKFLOW_ASYNC）。
 * 内存与写盘统一用 `async`：它是上下文关键字，作为属性名完全合法，
 * 且 `WorkflowConfig` 是对外导出的公共类型，改名属于破坏性变更。
 */
export type WorkflowBackend = "workflow" | "subagent";

export interface WorkflowConfig {
	/** 执行后端：内置 workflow agent 或 pi-interactive-subagents 子会话。 */
	backend: WorkflowBackend;
	/** 是否以后台异步模式运行 workflow（注册 workflow_cancel 工具）。 */
	async: boolean;
}

/** 未知字段和非法取值时的错误信息前缀，供调用方识别。 */
const CONFIG_FIELD_ERROR = "workflow configuration";

const DEFAULTS: WorkflowConfig = { backend: "workflow", async: false };

/** 配置文件路径：<agentDir>/extensions/pi-dynamic-workflows/config.json */
export function configPath(agentDir = getAgentDir()): string {
	return join(agentDir, "extensions", "pi-dynamic-workflows", "config.json");
}

/** 环境变量兜底值；没有对应环境变量时用默认值。 */
function fromEnv(): WorkflowConfig {
	const config = { ...DEFAULTS };
	if (process.env.PI_WORKFLOW_BACKEND === "subagent") config.backend = "subagent";
	if (process.env.PI_WORKFLOW_ASYNC === "true") config.async = true;
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
		if (key !== "backend" && key !== "async") {
			throw new Error(`unknown ${CONFIG_FIELD_ERROR} field: ${key}`);
		}
	}
	if (raw.backend !== undefined && raw.backend !== "workflow" && raw.backend !== "subagent") {
		throw new Error(`${CONFIG_FIELD_ERROR}: backend must be one of: workflow, subagent`);
	}
	if (raw.async !== undefined && typeof raw.async !== "boolean") {
		throw new Error(`${CONFIG_FIELD_ERROR}: async must be a boolean`);
	}
	return {
		backend: (raw.backend as WorkflowBackend | undefined) ?? DEFAULTS.backend,
		async: (raw.async as boolean | undefined) ?? DEFAULTS.async,
	};
}

/** 读取配置：JSON 文件覆盖环境变量兜底值。文件缺失或损坏时静默回退到环境变量/默认值。 */
export function loadConfig(path = configPath()): WorkflowConfig {
	const config = fromEnv();
	try {
		if (!existsSync(path)) return config;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		if (parsed.backend === "workflow" || parsed.backend === "subagent") config.backend = parsed.backend;
		if (typeof parsed.async === "boolean") config.async = parsed.async;
	} catch {
		// 配置损坏：保留环境变量兜底值，不抛出。
	}
	return config;
}

/** 合并写入配置，返回写入后的完整配置；写盘前过一遍 parseConfig，保证磁盘上不会出现坏值。 */
export function saveConfig(partial: Partial<WorkflowConfig>, path = configPath()): WorkflowConfig {
	const merged = parseConfig({ ...loadConfig(path), ...partial });
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
	return merged;
}
