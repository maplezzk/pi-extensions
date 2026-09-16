/**
 * 折叠扩展写入的自定义条目（custom entry）。
 *
 * 为什么得单独补一个地方：Pi 只从扩展入口导出 AssistantMessageComponent 与
 * ToolExecutionComponent，而 `pi.appendEntry` 写的条目由内部的 CustomEntryComponent
 * 渲染 —— 它既没有公开导出，也没有折叠信号（EntryRenderer 只收到 `expanded`）。
 * 所以这里补丁 `Container.prototype.render`，用特征认出条目组件，折叠态返回 0 行。
 * 特征判定的成本是一次属性读取，普通容器直接短路。
 *
 * 补丁要同时装在两份 Container 上：`@earendil-works/pi-tui` 可能被安装成两份
 * （扩展解析到一份，Pi 内部组件继承另一份），两边的 `Container.prototype` 不是
 * 同一个对象。具体见 resolveContainerPrototypes。
 *
 * 只折「工作条目」，归属在条目第一次渲染时确定：
 * - 一次运行（agent_start → agent_settled）期间 —— 例如 distill 审计行、
 *   tool-supervisor 审计行、pi-metrics 的逐轮遥测；
 * - 会话恢复窗口（session_start 之后、首次 agent_start 之前）—— 历史轮次留下的
 *   条目，与历史工具行一样属于工作过程。
 * 运行结束后才出现的条目（提示、汇总）保持可见；pi-extensions-i18n 的通知条目
 * 无论何时都豁免，否则「配置读取失败」这类警告会被一起收掉。
 */

import { Container } from "@earendil-works/pi-tui";
import { NOTICE_ENTRY_TYPE } from "pi-extensions-i18n";
import { installMethodPatch, type PatchablePrototype } from "./prototype-patch.js";
import type { CleanModeConfig, CleanModeState } from "./types.js";

/** 空渲染结果：条目被收起时一行都不占。 */
const NO_LINES: string[] = [];

/**
 * 条目组件对外可见的最小结构。
 *
 * 三个字段必须同时成立才算条目组件：Pi 的 CustomEntryComponent 持有原始 entry、
 * 渲染函数，并对外提供 hasContent。普通容器（含 chatContainer 自己）没有这组字段，
 * 因此在热路径上只花一次属性读取。
 */
export interface ExtensionEntryHost {
	entry?: unknown;
	renderer?: unknown;
	hasContent?: unknown;
}

/** 条目载荷里渲染决策需要的字段。 */
interface ExtensionEntryPayload {
	customType?: unknown;
}

/** 判断一个组件是不是扩展写入的条目组件。 */
export function isExtensionEntryHost(host: unknown): host is ExtensionEntryHost {
	if (typeof host !== "object" || host === null) {
		return false;
	}
	const candidate = host as ExtensionEntryHost;
	return (
		candidate.entry !== undefined &&
		typeof candidate.renderer === "function" &&
		typeof candidate.hasContent === "function"
	);
}

/** 取条目的 customType；缺失或不是非空字符串时返回 undefined。 */
export function readExtensionEntryCustomType(host: ExtensionEntryHost): string | undefined {
	const payload = host.entry as ExtensionEntryPayload | undefined;
	const customType = payload?.customType;
	return typeof customType === "string" && customType.length > 0 ? customType : undefined;
}

/**
 * 判定条目第一次渲染时是否落在「工作窗口」内。
 *
 * 运行中本身就是工作过程；会话恢复窗口内的条目属于历史轮次的工作过程，同样按
 * 工作条目处理，这样 `/resume` 之后的审计行不会比工具行更显眼。
 */
export function isExtensionEntryWorkWindow(input: {
	state: CleanModeState;
	isHistoryRestoreWindow: boolean;
}): boolean {
	return input.isHistoryRestoreWindow || !input.state.runSettled;
}

/** 判定一条扩展条目折叠时是否该隐藏所需的输入。 */
export interface ExtensionEntryHideInput {
	state: CleanModeState;
	config: CleanModeConfig;
	/** entry 的 customType；无法读出时为 undefined。 */
	customType?: string;
	/** 该条目是否在工作窗口内首次渲染，由补丁层标记后传入。 */
	isWorkEntry: boolean;
}

/**
 * 判定一条扩展条目在当前位置该不该隐藏。
 *
 * 任一前置条件不成立就放行原始渲染：总开关关闭、条目折叠开关关闭、当前不是折叠态、
 * 条目不属于工作过程。通知条目是唯一的类型豁免 —— 它是扩展在出错时唯一能说话的
 * 地方，收起来等于把警告藏了。
 */
export function shouldHideExtensionEntry(input: ExtensionEntryHideInput): boolean {
	const { state, config, customType, isWorkEntry } = input;
	if (!config.enabled || !config.hideExtensionEntries || !state.collapsed) {
		return false;
	}
	if (!isWorkEntry) {
		return false;
	}
	return customType !== NOTICE_ENTRY_TYPE;
}

/** Container.render 的补丁签名；容器接口只保证返回行数组。 */
type ContainerRenderMethod = (this: object, width: number) => string[];

/** 补丁层从扩展入口注入的依赖。 */
export interface ExtensionEntryPatchDeps {
	/** 读取当前折叠状态。 */
	getState: () => CleanModeState;
	/** 读取当前配置。 */
	getConfig: () => CleanModeConfig;
	/** 是否处于会话恢复窗口：session_start 之后、首次 agent_start 之前。 */
	isHistoryRestoreWindow: () => boolean;
	/** 要接管的 Container 原型列表；由入口按运行时解析情况提供。 */
	containerPrototypes: object[];
}

/**
 * 收集候选 Container 原型时的输入。
 *
 * `@earendil-works/pi-tui` 在 node_modules 里可能是两份：扩展自己 import 的那份，
 * 与 Pi 内部组件继承的那份。两边的 `Container.prototype` 不是同一个对象，只补一份
 * 会让条目折叠在没有提升成单份的布局下静默失效。
 */
export interface ContainerPrototypeSources {
	/** 扩展自己 import 的 Container 原型；npm 提升成单份时它就是 Pi 用的那份。 */
	ownContainerPrototype: object;
	/** Pi 导出组件的原型；内部条目组件继承的就是它的父原型。 */
	piComponentPrototype: object;
}

/**
 * 收集所有可能承载条目渲染的 Container 原型。
 *
 * 第二个候选取自 Pi 导出组件的父原型：Pi 内部的 CustomEntryComponent 是
 * `extends Container`（见 dist/modes/interactive/components/custom-entry.js），
 * 继承的就是这个原型。组件类由入口传入，本函数只做结构判断，便于单测替换。
 */
export function resolveContainerPrototypes(sources: ContainerPrototypeSources): object[] {
	const { ownContainerPrototype, piComponentPrototype } = sources;
	const prototypes: object[] = [ownContainerPrototype];
	const piPrototype: unknown = Object.getPrototypeOf(piComponentPrototype);

	if (
		piPrototype !== null &&
		typeof piPrototype === "object" &&
		piPrototype !== ownContainerPrototype &&
		typeof Reflect.get(piPrototype, "render") === "function"
	) {
		prototypes.push(piPrototype);
	}
	return prototypes;
}

/**
 * 安装扩展条目补丁。
 *
 * 返回还原函数，供 reload / shutdown 使用；重复调用是幂等的（骨架负责）。
 * 归属判定按实例缓存在 WeakSet 里：条目属于哪个窗口在首次渲染时就定下来了，
 * 之后运行结束也不能反悔 —— 否则刚展示过的工作行会在收起时反而留在屏幕上。
 */
export function installExtensionEntryPatch(deps: ExtensionEntryPatchDeps): () => void {
	const workEntries = new WeakSet<object>();

	/** 条目组件的渲染接管；两份原型共用同一份实现与同一张归属表。 */
	const buildMethod = (originalRender: ContainerRenderMethod): ContainerRenderMethod =>
		function patchedRender(this: object, width: number): string[] {
			if (!isExtensionEntryHost(this)) {
				return originalRender.call(this, width);
			}

			const state = deps.getState();
			const config = deps.getConfig();
			const isWorkEntry =
				workEntries.has(this) ||
				(config.enabled &&
					config.hideExtensionEntries &&
					isExtensionEntryWorkWindow({
						state,
						isHistoryRestoreWindow: deps.isHistoryRestoreWindow(),
					}));
			if (isWorkEntry) {
				workEntries.add(this);
			}

			if (
				shouldHideExtensionEntry({
					state,
					config,
					customType: readExtensionEntryCustomType(this),
					isWorkEntry,
				})
			) {
				return NO_LINES;
			}
			return originalRender.call(this, width);
		};

	const restores = deps.containerPrototypes.map((prototype) =>
		installMethodPatch<ContainerRenderMethod>({
			prototype: prototype as PatchablePrototype,
			methodName: "render",
			currentMethod: Reflect.get(prototype, "render") as ContainerRenderMethod | undefined,
			buildMethod,
		}),
	);

	return () => {
		for (const restore of restores) {
			restore();
		}
	};
}
