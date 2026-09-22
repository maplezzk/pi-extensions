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
 * 运行结束后才出现的条目（提示、汇总）保持可见；pi-extensions-i18n 的通知条目按级别区分
 * —— `info` 级（metrics 的逐轮遥测、配置保存成功）属于过程噪声，跟着工作过程一起收起；
 * `warning` / `error` 是扩展出错时唯一能说话的地方，无论何时都留着，否则警告会被静默吞掉。
 */

import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { NOTICE_ENTRY_TYPE } from "pi-extensions-i18n";
import { installMethodPatch, type PatchablePrototype } from "./prototype-patch.js";
import type { CleanModeConfig, CleanModeState } from "./types.js";

/** 空渲染结果：条目被收起时一行都不占。 */
const NO_LINES: string[] = [];
/**
 * 扩展条目轨道前缀占用的列宽。
 *
 * 加前缀的一方要按它把渲染宽度让出来（`width - ENTRY_RAIL_WIDTH`），前缀再补回这两列，
 * 整行宽度才不会溢出。数值与 `GUTTER_PREFIX_WIDTH` 一致。
 */
const ENTRY_RAIL_WIDTH = 2;

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

/**
 * 扩展注册的消息组件对外可见的最小结构（对应 Pi 的 CustomMessageComponent）。
 *
 * 它和条目组件一样铺满整宽（工作流结果面板就是它），运行期间同样会切断轨道，
 * 所以也要接上。它是一个独立判定：消息组件不参与条目折叠（`hideExtensionEntries`），
 * 只参与接轨道。
 */
export interface ExtensionMessageHost {
	message?: unknown;
	customRenderer?: unknown;
	setExpanded?: unknown;
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

/**
 * 判断一个组件是不是扩展注册的消息组件。
 *
 * 三个字段必须同时成立：Pi 的 CustomMessageComponent 持有 message、customRenderer，
 * 并对外提供 setExpanded。普通容器与条目组件都没有这组字段。
 */
export function isExtensionMessageHost(host: unknown): host is ExtensionMessageHost & object {
	if (typeof host !== "object" || host === null) {
		return false;
	}
	const candidate = host as ExtensionMessageHost;
	return (
		candidate.message !== undefined &&
		typeof candidate.customRenderer === "function" &&
		typeof candidate.setExpanded === "function"
	);
}

/** 取条目的 customType；缺失或不是非空字符串时返回 undefined。 */
export function readExtensionEntryCustomType(host: ExtensionEntryHost): string | undefined {
	const payload = host.entry as ExtensionEntryPayload | undefined;
	const customType = payload?.customType;
	return typeof customType === "string" && customType.length > 0 ? customType : undefined;
}

/**
 * 读通知条目的级别。
 *
 * 通知条目由 pi-extensions-i18n 写成 `{ tag, color, level, message, ... }`。读不出来
 * （别的包用了同一个 customType、字段改过、老版本）时返回 undefined，调用方按「留着」处理
 * —— 宁可多显示一条，也不能把警告静默吞掉。
 */
export function readExtensionEntryNoticeLevel(host: ExtensionEntryHost): string | undefined {
	const payload = host.entry as { data?: unknown } | undefined;
	const data = payload?.data;
	if (typeof data !== "object" || data === null) {
		return undefined;
	}

	const level = (data as { level?: unknown }).level;
	return typeof level === "string" ? level : undefined;
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

/**
 * 取可接轨道的块的归属键。
 *
 * 用条目/消息对象（而不是组件实例）：Pi 会重建组件，按实例记归属会让同一块的判定
 * 在重建后翻面。消息组件用 `message`，条目组件用 `entry`。
 */
export function readRailOwnershipKey(host: (ExtensionEntryHost | ExtensionMessageHost) & object): object {
	const entry = (host as ExtensionEntryHost).entry;
	if (typeof entry === "object" && entry !== null) {
		return entry;
	}
	const message = (host as ExtensionMessageHost).message;
	return typeof message === "object" && message !== null ? message : host;
}

/**
 * 判定一条扩展条目在当前位置是否该接上运行时轨道。
 *
 * 运行期间扩展写入的条目（通知提示、工作流结果面板、审计卡片）都铺满整宽，
 * 它们会把左侧轨道从中间切断；接上 `│ ` 前缀，竖条才不会断。
 *
 * 两种情况不加：总开关关闭（根本没有轨道可接）；收起态（组头本身不显示，加一条
 * 孤立竖条反而多出个没头没尾的结构字符）。
 */
export function shouldRailExtensionEntry(input: ExtensionEntryRailInput): boolean {
	const { state, config } = input;
	if (!config.enabled) {
		return false;
	}
	return !state.collapsed && !state.runSettled;
}

/**
 * 给条目的每一行加上轨道前缀。
 *
 * 调用方传入按 `width - ENTRY_RAIL_WIDTH` 渲染出来的行，前缀正好补回这两列：整行宽度不变，
 * 条目自己的底色仍然铺到右边缘。
 */
export function applyEntryRail(lines: readonly string[], prefix: string): string[] {
	return lines.map((line) => `${prefix}${line}`);
}

/**
 * 去掉渲染结果开头自带的空行。
 *
 * Pi 的条目组件与消息组件都在自己的内容前面插一个 `Spacer(1)`（见 Pi 的
 * custom-entry.js / custom-message.js）：普通视图里它是块与块之间的呼吸空间，但运行期间
 * 清爽模式画的是「一行一条」的密集列表，这一行就成了列表中间的一个空洞 —— 上下都是紧挨着的
 * 记录，只有扩展块前面空出一行，看起来像列表被随机断开。接轨道时顺手去掉。
 *
 * 只去开头的空行：末尾的空行不是 Pi 加的，留着不动；整块全是空行时返回原样，
 * 免得把一个本来就空白的块变成 0 行。
 */
export function dropLeadingBlankLines(lines: readonly string[]): string[] {
	const firstContent = lines.findIndex((line) => visibleWidth(line) > 0);
	return firstContent <= 0 ? [...lines] : lines.slice(firstContent);
}

/** 判定一条扩展条目收起时是否该隐藏所需的输入。 */
export interface ExtensionEntryHideInput {
	state: CleanModeState;
	config: CleanModeConfig;
	/** entry 的 customType；无法读出时为 undefined。 */
	customType?: string;
	/** 通知条目的级别（`info` / `warning` / `error`）；非通知或读不出来时为 undefined。 */
	noticeLevel?: string;
	/** 该条目是否在工作窗口内首次渲染，由补丁层标记后传入。 */
	isWorkEntry: boolean;
}

/** 收起时会一起藏掉的通知级别：只有 info。 */
const HIDDEN_NOTICE_LEVEL = "info";

/**
 * 判定一条扩展条目在当前位置该不该隐藏。
 *
 * 任一前置条件不成立就放行原始渲染：总开关关闭、条目折叠开关关闭、当前不是折叠态、
 * 条目不属于工作过程。通知条目不是全部豁免：`info` 级通知（遥测、回执）和普通工作条目
 * 一样收起，`warning` / `error` 留着 —— 扩展出错时只有它俩能说话，收起来等于把警告藏了。
 */
export function shouldHideExtensionEntry(input: ExtensionEntryHideInput): boolean {
	const { state, config, customType, noticeLevel, isWorkEntry } = input;
	if (!config.enabled || !config.hideExtensionEntries || !state.collapsed) {
		return false;
	}
	if (!isWorkEntry) {
		return false;
	}

	return customType !== NOTICE_ENTRY_TYPE || noticeLevel === HIDDEN_NOTICE_LEVEL;
}

/** Container.render 的补丁签名；容器接口只保证返回行数组。 */
type ContainerRenderMethod = (this: object, width: number) => string[];

/** 判定一条条目是否该接上轨道前缀所需的输入。 */
export interface ExtensionEntryRailInput {
	state: CleanModeState;
	config: CleanModeConfig;
}

/** 补丁层从扩展入口注入的依赖。 */
export interface ExtensionEntryPatchDeps {
	/** 读取当前折叠状态。 */
	getState: () => CleanModeState;
	/** 读取当前配置。 */
	getConfig: () => CleanModeConfig;
	/** 是否处于会话恢复窗口：session_start 之后、首次 agent_start 之前。 */
	isHistoryRestoreWindow: () => boolean;
	/**
	 * 取当前轨道前缀（已着色，如 `│ `）。
	 *
	 * 主题还没就绪时返回 undefined，调用方按原样渲染 —— 宁可少加前缀，也不能因为
	 * 取不到着色能力把条目画坏。
	 */
	getEntryRailPrefix: () => string | undefined;
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
	/**
	 * 归属记在**条目对象**上，不记在组件实例上。
	 *
	 * Pi 会重建条目组件（同一条目对象换一个新实例），按实例记归属会让同一条提示的判定
	 * 在重建后翻面：实测启动时的提示本来不带竖条，运行中重建后突然带上了。
	 */
	const workEntries = new WeakSet<object>();
	/** 条目对象 -> 是否该接轨道；首次渲染时定下，正负两种结果都记，重建后不再翻面。 */
	const railDecisions = new WeakMap<object, boolean>();

	/**
	 * 判定条目是否该接上轨道前缀，并在首次渲染时把归属固定下来。
	 *
	 * 归属只能算一次：Pi 每帧都会重渲整段对话，同一条提示会反复经过这里。归属跟着
	 * 「首次渲染时本轮在不在跑」走，运行结束后不再反过来改——否则屏幕上会看到轨道
	 * 前缀在收起那一瞬间凭空出现或消失。
	 */
	const shouldRail = (
		host: (ExtensionEntryHost | ExtensionMessageHost) & object,
		state: CleanModeState,
		config: CleanModeConfig,
	): boolean => {
		const key = readRailOwnershipKey(host);
		const decided = railDecisions.get(key);
		if (decided !== undefined) {
			return decided;
		}
		const railed = shouldRailExtensionEntry({ state, config });
		railDecisions.set(key, railed);
		return railed;
	};

	/**
	 * 块组件的渲染接管；两份原型共用同一份实现与同一张归属表。
	 *
	 * 两类块走这里：扩展条目（要折叠，也要接轨道）与扩展注册的消息（只接轨道）。
	 * 其余容器（包括 chatContainer 自己）只花一次属性读取就原样返回。
	 */
	const buildMethod = (originalRender: ContainerRenderMethod): ContainerRenderMethod =>
		function patchedRender(this: object, width: number): string[] {
			const entryHost = isExtensionEntryHost(this) ? this : undefined;
			if (entryHost === undefined && !isExtensionMessageHost(this)) {
				return originalRender.call(this, width);
			}

			const state = deps.getState();
			const config = deps.getConfig();

			if (entryHost !== undefined) {
				const ownershipKey = readRailOwnershipKey(entryHost);
				const isWorkEntry =
					workEntries.has(ownershipKey) ||
					(config.enabled &&
						config.hideExtensionEntries &&
						isExtensionEntryWorkWindow({
							state,
							isHistoryRestoreWindow: deps.isHistoryRestoreWindow(),
						}));
				if (isWorkEntry) {
					workEntries.add(ownershipKey);
				}

				if (
					shouldHideExtensionEntry({
						state,
						config,
						customType: readExtensionEntryCustomType(entryHost),
						noticeLevel: readExtensionEntryNoticeLevel(entryHost),
						isWorkEntry,
					})
				) {
					return NO_LINES;
				}
			}

			const railHost = this as (ExtensionEntryHost | ExtensionMessageHost) & object;
			const railPrefix = shouldRail(railHost, state, config) ? deps.getEntryRailPrefix() : undefined;
			// 宽度不够让出前缀时按原样渲染：宁可轨道断一下，也不能把内容画坏。
			if (railPrefix === undefined || width <= ENTRY_RAIL_WIDTH) {
				return originalRender.call(this, width);
			}
			const railed = dropLeadingBlankLines(originalRender.call(this, width - ENTRY_RAIL_WIDTH));
			return applyEntryRail(railed, railPrefix);
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
