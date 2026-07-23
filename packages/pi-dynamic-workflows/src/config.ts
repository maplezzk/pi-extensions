import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Workflow 运行时配置。
 *
 * 优先级：JSON 配置文件（由 /workflow-config 斜杠命令写入）> 环境变量兜底 > 默认值。
 * 环境变量仅作为兜底支持（PI_WORKFLOW_BACKEND / PI_WORKFLOW_ASYNC）。
 */
export type WorkflowBackend = "workflow" | "subagent";

export interface WorkflowConfig {
	/** 执行后端：内置 workflow agent 或 pi-interactive-subagents 子会话。 */
	backend: WorkflowBackend;
	/** 是否以后台异步模式运行 workflow（注册 workflow_cancel 工具）。 */
	async: boolean;
}

const DEFAULTS: WorkflowConfig = { backend: "workflow", async: false };

/** 配置文件路径：<agentDir>/extensions/pi-dynamic-workflows/config.json */
export function configPath(): string {
	return join(getAgentDir(), "extensions", "pi-dynamic-workflows", "config.json");
}

function fromEnv(): WorkflowConfig {
	const config = { ...DEFAULTS };
	if (process.env.PI_WORKFLOW_BACKEND === "subagent") config.backend = "subagent";
	if (process.env.PI_WORKFLOW_ASYNC === "true") config.async = true;
	return config;
}

/** 读取配置：JSON 文件覆盖环境变量兜底值。文件缺失或损坏时静默回退到环境变量/默认值。 */
export function loadConfig(): WorkflowConfig {
	const config = fromEnv();
	try {
		if (!existsSync(configPath())) return config;
		const parsed = JSON.parse(readFileSync(configPath(), "utf-8")) as Partial<WorkflowConfig>;
		if (parsed.backend === "workflow" || parsed.backend === "subagent") config.backend = parsed.backend;
		if (typeof parsed.async === "boolean") config.async = parsed.async;
	} catch {
		// 配置损坏：保留环境变量兜底值，不抛出。
	}
	return config;
}

/** 合并写入配置，返回写入后的完整配置。 */
export function saveConfig(partial: Partial<WorkflowConfig>): WorkflowConfig {
	const merged: WorkflowConfig = { ...loadConfig(), ...partial };
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
	return merged;
}
