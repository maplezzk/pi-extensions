/**
 * 组件原型补丁。
 *
 * Pi 在扩展入口导出 AssistantMessageComponent 与 ToolExecutionComponent，
 * 这里接管两者的 render / updateContent，实现「折叠时只留最终答案」：
 *
 * - assistant 消息：工作过程（带 tool call）整条隐藏；最终答案保留；
 * - 工具行：整行隐藏，由于空渲染会返回 []，连前置空行一起消失；
 * - 折叠头：作为最终答案容器里的第一个子组件插入，并包一层 MouseRegion，
 *   因此全屏模式下可以鼠标点击切换折叠状态。
 *
 * 为什么可以用「带不带 tool call」区分工作过程与最终答案：agent 循环在没有
 * tool call 时结束，所以一次运行里不带 tool call 的 assistant 消息只有最后一条。
 *
 * 折叠头做成子组件而不是 render 里拼接的字符串，是因为 Container 的鼠标分发
 * 按子组件高度计算 y 偏移；用拼接字符串会让偏移错位。
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { MouseRegion, type Component } from "@earendil-works/pi-tui";
import { formatDuration } from "./duration.js";
import { i18n } from "./i18n.js";
import {
	resolveAssistantMessageHidden,
	resolveRunHeader,
	resolveToolMessageRender,
	type AssistantMessageKind,
} from "./render-policy.js";
import { installMethodPatch, type PatchablePrototype } from "./prototype-patch.js";
import type { CleanModeConfig, CleanModeState } from "./types.js";

/** 折叠态的箭头，提示点击后展开。 */
const COLLAPSED_CHEVRON = "›";
/** 展开态的箭头，提示点击后收起。 */
const EXPANDED_CHEVRON = "⌄";
/** 折叠头之前的空行，用于与上方消息留出间距；下方间距由内容容器自带的 Spacer 提供。 */
const HEADER_LEADING_BLANK = "";
/** 折叠头子组件在实例上的缓存键。 */
const HEADER_CHILD_KEY: unique symbol = Symbol("piCleanModeHeaderChild");

/** assistant 组件对外可见的最小结构。 */
interface AssistantMessageHost {
	/** Pi 在 updateContent 里写入：该消息是否包含 tool call。 */
	hasToolCalls?: boolean;
	/** 内容容器；折叠头插在它的 children 首位。 */
	contentContainer?: { children: Component[] };
	render(width: number): string[];
	updateContent(message: unknown, isStreaming?: boolean): void;
	/** 折叠头子组件的实例级缓存。 */
	[HEADER_CHILD_KEY]?: Component;
}

/** 工具行组件对外可见的最小结构。 */
interface ToolMessageHost {
	render(width: number): string[];
}

/** assistant 组件的 render 方法签名。 */
type AssistantRenderMethod = (this: AssistantMessageHost, width: number) => string[];
/** assistant 组件的 updateContent 方法签名。 */
type AssistantUpdateMethod = (
	this: AssistantMessageHost,
	message: unknown,
	isStreaming?: boolean,
) => void;
/** 工具行组件的 render 方法签名。 */
type ToolRenderMethod = (this: ToolMessageHost, width: number) => string[];

/** 补丁层从扩展入口注入的依赖。 */
export interface ComponentPatchDeps {
	/** 读取当前折叠状态。 */
	getState: () => CleanModeState;
	/** 读取当前配置。 */
	getConfig: () => CleanModeConfig;
	/** 把折叠头文案染成弱化色；主题不可用时返回原文本。 */
	styleHeader: (text: string) => string;
	/** 鼠标点击折叠头时切换折叠状态。 */
	onToggle: () => void;
}

/** 把 Pi 的 hasToolCalls 映射成业务分类；映射规则见本文件顶部说明。 */
function classifyAssistantMessage(hasToolCalls: boolean): AssistantMessageKind {
	return hasToolCalls ? "work" : "final";
}

/** 组装折叠头那一行，例如 `用时 4m 26s ›`。 */
function buildRunHeaderLine(state: CleanModeState, deps: ComponentPatchDeps): string {
	const durationMs = state.runDurationMs ?? 0;
	const label = i18n.t("runHeader", { duration: formatDuration(durationMs) });
	const chevron = state.collapsed ? COLLAPSED_CHEVRON : EXPANDED_CHEVRON;
	const hint = deps.getConfig().showExpandHint ? ` ${chevron}` : "";
	return deps.styleHeader(`${label}${hint}`);
}

/**
 * 创建折叠头子组件。
 *
 * 可见时输出「空行 + 折叠头」两行：空行与上方消息拉开距离，折叠头下方则接
 * 内容容器原有的 Spacer。不可见时渲染 0 行，因此不占空间也不可点击。
 */
function createRunHeaderComponent(deps: ComponentPatchDeps): Component {
	const content: Component = {
		/** 可见时输出「空行 + 折叠头」，否则输出空行集。 */
		render: (width: number): string[] => {
			const decision = resolveRunHeader(deps.getState(), deps.getConfig());
			if (!decision.visible) {
				return [];
			}
			return [HEADER_LEADING_BLANK, buildRunHeaderLine(deps.getState(), deps)];
		},
		/** 无缓存状态，渲染时实时读取当前折叠状态。 */
		invalidate: () => {},
	};

	// 包一层 MouseRegion：左键点击折叠头即切换折叠状态。
	return new MouseRegion(content, (event) => {
		if (event.type !== "click" || event.button !== "left") {
			return undefined;
		}
		deps.onToggle();
		return { handled: true };
	});
}

/** 取出或创建该实例的折叠头子组件。 */
function getOrCreateRunHeader(host: AssistantMessageHost, deps: ComponentPatchDeps): Component {
	host[HEADER_CHILD_KEY] ??= createRunHeaderComponent(deps);
	return host[HEADER_CHILD_KEY];
}

/**
 * 包装 assistant 消息的 render：折叠时工作过程返回空数组。
 *
 * 折叠头不在这里拼接——它以子组件形式存在于内容容器里，由 Container 正常渲染。
 */
function buildAssistantMessageRender(
	deps: ComponentPatchDeps,
	originalRender: (this: AssistantMessageHost, width: number) => string[],
): (this: AssistantMessageHost, width: number) => string[] {
	return function patchedAssistantMessageRender(this: AssistantMessageHost, width: number) {
		const kind = classifyAssistantMessage(this.hasToolCalls === true);
		const hidden = resolveAssistantMessageHidden({
			state: deps.getState(),
			config: deps.getConfig(),
			kind,
		});

		if (hidden) {
			return [];
		}

		return originalRender.call(this, width);
	};
}

/**
 * 包装 assistant 消息的 updateContent。
 *
 * 原始实现会清空并重建内容容器，因此这里在它之后把折叠头插到 children 首位：
 * 最终答案消息始终带折叠头子组件，是否真的显示由子组件按当前状态决定。
 * 工作过程消息不插折叠头。
 */
function buildAssistantMessageUpdateContent(
	deps: ComponentPatchDeps,
	originalUpdateContent: (
		this: AssistantMessageHost,
		message: unknown,
		isStreaming?: boolean,
	) => void,
): (this: AssistantMessageHost, message: unknown, isStreaming?: boolean) => void {
	return function patchedAssistantMessageUpdateContent(
		this: AssistantMessageHost,
		message: unknown,
		isStreaming?: boolean,
	) {
		originalUpdateContent.call(this, message, isStreaming);

		const container = this.contentContainer;
		if (!container || this.hasToolCalls === true) {
			return;
		}

		container.children.unshift(getOrCreateRunHeader(this, deps));
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
 * 原始方法在调用点按具体类型读出并传入，因此不需要在补丁骨架里做类型断言。
 */
export function installComponentPatches(deps: ComponentPatchDeps): () => void {
	const assistantPrototype: PatchablePrototype = AssistantMessageComponent.prototype;

	const restoreAssistantRender = installMethodPatch<AssistantRenderMethod>({
		prototype: assistantPrototype,
		methodName: "render",
		currentMethod: AssistantMessageComponent.prototype.render,
		buildMethod: (originalRender) => buildAssistantMessageRender(deps, originalRender),
	});
	const restoreAssistantUpdate = installMethodPatch<AssistantUpdateMethod>({
		prototype: assistantPrototype,
		methodName: "updateContent",
		currentMethod: AssistantMessageComponent.prototype.updateContent,
		buildMethod: (originalUpdate) => buildAssistantMessageUpdateContent(deps, originalUpdate),
	});
	const restoreTool = installMethodPatch<ToolRenderMethod>({
		prototype: ToolExecutionComponent.prototype,
		methodName: "render",
		currentMethod: ToolExecutionComponent.prototype.render,
		buildMethod: (originalRender) => buildToolMessageRender(deps, originalRender),
	});

	return () => {
		restoreTool();
		restoreAssistantUpdate();
		restoreAssistantRender();
	};
}
