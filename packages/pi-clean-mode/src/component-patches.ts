/**
 * 组件原型补丁。
 *
 * Pi 在扩展入口导出 AssistantMessageComponent 与 ToolExecutionComponent，
 * 这里接管两者的 render()，实现「折叠时只留最终答案」：
 *
 * - assistant 消息：工作过程（带 tool call）整条隐藏；最终答案保留并加折叠头；
 * - 工具行：整行隐藏，由于空渲染会返回 []，连前置空行一起消失。
 *
 * 为什么可以用「带不带 tool call」区分工作过程与最终答案：agent 循环在没有
 * tool call 时结束，所以一次运行里不带 tool call 的 assistant 消息只有最后一条。
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./duration.js";
import { i18n } from "./i18n.js";
import {
	resolveAssistantMessageRender,
	resolveToolMessageRender,
	type AssistantMessageKind,
} from "./render-policy.js";
import { installRenderPatch, type PatchableRenderPrototype } from "./prototype-patch.js";
import type { CleanModeConfig, CleanModeState } from "./types.js";

/** assistant 组件对外可见的最小结构。 */
interface AssistantMessageHost {
	/** Pi 在 updateContent 里写入：该消息是否包含 tool call。 */
	hasToolCalls?: boolean;
	render(width: number): string[];
}

/** 工具行组件对外可见的最小结构。 */
interface ToolMessageHost {
	render(width: number): string[];
}

/** 补丁层从扩展入口注入的依赖。 */
export interface ComponentPatchDeps {
	/** 读取当前折叠状态。 */
	getState: () => CleanModeState;
	/** 读取当前配置。 */
	getConfig: () => CleanModeConfig;
	/** 把折叠头文案染成弱化色；主题不可用时返回原文本。 */
	styleHeader: (text: string) => string;
}

/** 折叠头末尾的展开提示符，暗示该行可以展开。 */
const EXPAND_HINT = " ›";

/** 把 Pi 的 hasToolCalls 映射成业务分类；映射规则见本文件顶部说明。 */
function classifyAssistantMessage(hasToolCalls: boolean): AssistantMessageKind {
	return hasToolCalls ? "work" : "final";
}

/** 组装折叠头那一行，例如 `用时 4m 26s ›`。 */
function buildRunHeaderLine(state: CleanModeState, deps: ComponentPatchDeps): string {
	const durationMs = state.runDurationMs ?? 0;
	const label = i18n.t("runHeader", { duration: formatDuration(durationMs) });
	const hint = deps.getConfig().showExpandHint ? EXPAND_HINT : "";
	return deps.styleHeader(`${label}${hint}`);
}

/**
 * 包装 assistant 消息的 render。
 *
 * hidden 时返回空数组，让该条消息不占任何行；需要折叠头时把折叠头插在
 * 原始输出的最前面，视觉上正好落在最终答案上方。
 */
function buildAssistantMessageRender(
	deps: ComponentPatchDeps,
	originalRender: (this: AssistantMessageHost, width: number) => string[],
): (this: AssistantMessageHost, width: number) => string[] {
	return function patchedAssistantMessageRender(this: AssistantMessageHost, width: number) {
		const state = deps.getState();
		const config = deps.getConfig();
		const decision = resolveAssistantMessageRender({
			state,
			config,
			kind: classifyAssistantMessage(this.hasToolCalls === true),
		});

		if (decision.hidden) {
			return [];
		}

		const lines = originalRender.call(this, width);
		if (!decision.showHeader) {
			return lines;
		}

		return [buildRunHeaderLine(state, deps), "", ...lines];
	};
}

/** 包装工具行的 render；折叠时整行隐藏。 */
function buildToolMessageRender(
	deps: ComponentPatchDeps,
	originalRender: (this: ToolMessageHost, width: number) => string[],
): (this: ToolMessageHost, width: number) => string[] {
	return function patchedToolMessageRender(this: ToolMessageHost, width: number) {
		const decision = resolveToolMessageRender(deps.getState(), deps.getConfig());
		if (decision.hidden) {
			return [];
		}
		return originalRender.call(this, width);
	};
}

/**
 * 安装 assistant 消息与工具行的渲染补丁。
 *
 * 返回还原函数，供 reload / shutdown 使用；重复调用是幂等的。
 */
export function installComponentPatches(deps: ComponentPatchDeps): () => void {
	const restoreAssistant = installRenderPatch(
		AssistantMessageComponent.prototype as PatchableRenderPrototype<
			(this: AssistantMessageHost, width: number) => string[]
		>,
		(originalRender) => buildAssistantMessageRender(deps, originalRender),
	);
	const restoreTool = installRenderPatch(
		ToolExecutionComponent.prototype as PatchableRenderPrototype<
			(this: ToolMessageHost, width: number) => string[]
		>,
		(originalRender) => buildToolMessageRender(deps, originalRender),
	);

	return () => {
		restoreTool();
		restoreAssistant();
	};
}
